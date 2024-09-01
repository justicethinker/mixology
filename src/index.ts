import { createApp } from "@deroll/app";
import { createRouter } from "@deroll/router";
import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  toHex,
  fromHex,
  keccak256,
  parseEther,
  formatEther,
} from "viem";
import { MerkleTree } from "fixed-merkle-tree";
import { poseidon } from "circomlibjs";
import { groth16 } from "snarkjs";

const ROLLUP_SERVER =
  process.env.ROLLUP_HTTP_SERVER_URL || "http://127.0.0.1:5004";
const MIXER_CONTRACT_ADDRESS =
  process.env.MIXER_CONTRACT_ADDRESS || "0xMixerContractAddress";
const TREE_HEIGHT = 20; // Allows for over 1 million deposits

const app = createApp({ url: ROLLUP_SERVER });

const contractAbi = parseAbi([
  "function deposit(uint256 amount, bytes32 commitment)",
  "function withdraw(bytes32 nullifierHash, address recipient, uint256 amount, uint256[] calldata merkleProof, bytes calldata zkProof)",
  "function setDenomination(uint256 newDenomination)",
  "function emergencyWithdraw()",
]);

interface Deposit {
  commitment: string;
  leafIndex: number;
  timestamp: number;
}

class MixerState {
  private deposits: Map<string, Deposit> = new Map();
  private nullifiers: Set<string> = new Set();
  private merkleTree: MerkleTree;
  public denomination: bigint = parseEther("1"); // Default 1 ETH
  private totalDeposits: bigint = BigInt(0);

  constructor() {
    this.merkleTree = new MerkleTree(TREE_HEIGHT, [], {
      hashFunction: poseidon,
      zeroElement:
        "21663839004416932945382355908790599225266501822907911457504978515578255421292", // Poseidon hash of 0
    });
  }

  addDeposit(commitment: string): boolean {
    if (this.deposits.has(commitment)) return false;
    const leafIndex = this.merkleTree.insert(commitment);
    this.deposits.set(commitment, {
      commitment,
      leafIndex,
      timestamp: Date.now(),
    });
    this.totalDeposits += this.denomination;
    return true;
  }

  verifyWithdrawal(nullifierHash: string, merkleProof: string[]): boolean {
    if (this.nullifiers.has(nullifierHash)) return false;
    // In a real implementation, we would verify the Merkle proof here
    // For simplicity, we're just checking if the commitment exists
    const commitment = merkleProof[0]; // Assuming the first element is the commitment
    return this.deposits.has(commitment);
  }

  processWithdrawal(nullifierHash: string): boolean {
    if (this.nullifiers.has(nullifierHash)) return false;
    this.nullifiers.add(nullifierHash);
    this.totalDeposits -= this.denomination;
    return true;
  }

  setDenomination(newDenomination: bigint): void {
    this.denomination = newDenomination;
  }

  getMerkleRoot(): string {
    return this.merkleTree.root;
  }

  getDepositCount(): number {
    return this.deposits.size;
  }

  getTotalDeposits(): string {
    return formatEther(this.totalDeposits);
  }
}

const mixerState = new MixerState();

app.addAdvanceHandler(async ({ payload, metadata }) => {
  try {
    const { functionName, args } = decodeFunctionData({
      abi: contractAbi,
      data: payload,
    });

    switch (functionName) {
      case "deposit":
        const [amount, commitment] = args;
        if (BigInt(amount) !== mixerState.denomination) {
          app.createNotice({
            payload: toHex(
              `Invalid deposit amount. Expected ${mixerState.denomination}, got ${amount}`,
            ),
          });
          return "reject";
        }
        if (!mixerState.addDeposit(commitment)) {
          app.createNotice({ payload: toHex(`Commitment already exists`) });
          return "reject";
        }
        app.createNotice({ payload: toHex(`Deposit added: ${commitment}`) });

        app.createVoucher({
          destination: MIXER_CONTRACT_ADDRESS,
          payload: encodeFunctionData({
            abi: parseAbi(["function transferFrom(address,address,uint256)"]),
            functionName: "transferFrom",
            args: [metadata.msg_sender, MIXER_CONTRACT_ADDRESS, amount],
          }),
        });
        return "accept";

      case "withdraw":
        const [nullifierHash, recipient, withdrawAmount, merkleProof, zkProof] =
          args;
        if (BigInt(withdrawAmount) !== mixerState.denomination) {
          app.createNotice({
            payload: toHex(
              `Invalid withdrawal amount. Expected ${mixerState.denomination}, got ${withdrawAmount}`,
            ),
          });
          return "reject";
        }

        if (!mixerState.verifyWithdrawal(nullifierHash, merkleProof)) {
          app.createNotice({ payload: toHex(`Invalid withdrawal proof`) });
          return "reject";
        }

        // Verify zk-SNARK proof
        const verification = await groth16.verify(
          verificationKey,
          publicSignals,
          zkProof,
        );
        if (!verification) {
          app.createNotice({ payload: toHex(`Invalid zk-SNARK proof`) });
          return "reject";
        }

        if (!mixerState.processWithdrawal(nullifierHash)) {
          app.createNotice({ payload: toHex(`Nullifier hash already used`) });
          return "reject";
        }

        app.createNotice({
          payload: toHex(`Withdrawal processed: ${nullifierHash}`),
        });

        app.createVoucher({
          destination: MIXER_CONTRACT_ADDRESS,
          payload: encodeFunctionData({
            abi: parseAbi(["function transfer(address,uint256)"]),
            functionName: "transfer",
            args: [recipient, withdrawAmount],
          }),
        });
        return "accept";

      case "setDenomination":
        const [newDenomination] = args;
        mixerState.setDenomination(BigInt(newDenomination));
        app.createNotice({
          payload: toHex(`New denomination set: ${newDenomination}`),
        });
        return "accept";

      case "emergencyWithdraw":
        // In a real implementation, you'd need to implement logic to halt deposits and allow users to withdraw their funds
        app.createNotice({ payload: toHex(`Emergency withdrawal initiated`) });
        return "accept";

      default:
        return "reject";
    }
  } catch (error) {
    console.error("Error in advance handler:", error);
    return "reject";
  }
});

const router = createRouter({ app });

// 1. General Mixer Info
router.add("mixerInfo", () => {
  return JSON.stringify({
    denomination: formatEther(mixerState.denomination),
    depositCount: mixerState.getDepositCount(),
    totalDeposits: mixerState.getTotalDeposits(),
    merkleRoot: mixerState.getMerkleRoot(),
    treeHeight: TREE_HEIGHT,
    mixerContractAddress: MIXER_CONTRACT_ADDRESS,
  });
});

// 2. Deposit History (paginated)
router.add<{ page: string; limit: string }>(
  "depositHistory/:page/:limit",
  ({ params: { page, limit } }) => {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const deposits = Array.from(mixerState.deposits.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice((pageNum - 1) * limitNum, pageNum * limitNum)
      .map(({ commitment, leafIndex, timestamp }) => ({
        commitment,
        leafIndex,
        timestamp,
      }));

    return JSON.stringify({
      deposits,
      totalDeposits: mixerState.deposits.size,
      currentPage: pageNum,
      totalPages: Math.ceil(mixerState.deposits.size / limitNum),
    });
  },
);

// 3. Check Nullifier Status
router.add<{ nullifierHash: string }>(
  "nullifierStatus/:nullifierHash",
  ({ params: { nullifierHash } }) => {
    const isUsed = mixerState.nullifiers.has(nullifierHash);
    return JSON.stringify({
      nullifierHash,
      isUsed,
      timestamp: isUsed ? mixerState.nullifiers.get(nullifierHash) : null,
    });
  },
);

// 4. Merkle Tree Path for a given leaf
router.add<{ leafIndex: string }>(
  "merklePath/:leafIndex",
  ({ params: { leafIndex } }) => {
    const index = parseInt(leafIndex);
    if (index >= mixerState.getDepositCount()) {
      return JSON.stringify({ error: "Leaf index out of range" });
    }
    const path = mixerState.merkleTree.path(index);
    return JSON.stringify({
      leafIndex: index,
      path: path.pathElements.map((el) => el.toString()),
      root: mixerState.getMerkleRoot(),
    });
  },
);

// 5. System Health Check
router.add("healthCheck", () => {
  const lastProcessedTimestamp = mixerState.getLastProcessedTimestamp();
  const currentTimestamp = Date.now();
  const timeSinceLastProcess = currentTimestamp - lastProcessedTimestamp;

  const isHealthy = timeSinceLastProcess < 300000; // 5 minutes

  return JSON.stringify({
    isHealthy,
    lastProcessedTimestamp,
    currentTimestamp,
    timeSinceLastProcess,
    depositCount: mixerState.getDepositCount(),
    withdrawalCount: mixerState.getNullifierCount(),
    merkleTreeSize: mixerState.merkleTree.length,
    memoryUsage: process.memoryUsage(),
  });
});

app.addInspectHandler(router.handler);

// Start the app
app.start().catch((e) => {
  console.error("Error starting the app:", e);
  process.exit(1);
});
