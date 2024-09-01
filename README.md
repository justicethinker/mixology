# Mixology

## Overview

This Cartesi DApp implements a privacy-preserving Ethereum mixer. It allows users to deposit ETH into a pool and later withdraw it to a different address, breaking the on-chain link between the deposit and withdrawal. The mixer utilizes zero-knowledge proofs and Merkle trees to ensure user privacy while maintaining the integrity of the system.

## Features

- Fixed denomination deposits and withdrawals
- Zero-knowledge proof verification for withdrawals
- Merkle tree-based deposit management
- Real-time mixer state inspection
- Emergency withdrawal functionality

## Installation

1. **Clone the Repository:**

   ```bash
   git clone https://github.com/justicethinker/mixology.git
   cd mixology
   ```

2. **Install Dependencies:**

   ```bash
   pnpm install
   ```

3. **Build the Project:**
   ```bash
   pnpm build
   ```

## Running the Mixer

1. **Start the Cartesi Node:**
   Follow Cartesi's documentation to set up and run a Cartesi node.

2. **Build the Mixer:**

   ```bash
   cartesi build
   ```

3. **Start the Mixer DApp:**
   ```bash
   cartesi run
   ```

## Usage

### Depositing Funds

To deposit ETH into the mixer:

```bash
cartesi send --payload '{
  "functionName": "deposit",
  "args": [
    "1000000000000000000",
    "0x1234...5678"  # Your commitment
  ]
}'
```

### Withdrawing Funds

To withdraw ETH from the mixer:

```bash
cartesi send --payload '{
  "functionName": "withdraw",
  "args": [
    "0xabcd...ef01",  # Nullifier hash
    "0x9876...5432",  # Recipient address
    "1000000000000000000",
    ["0x2345...6789", "0x3456...7890"],  # Merkle proof
    "0x5678...9012"  # zk-SNARK proof
  ]
}'
```

### Inspecting Mixer State

1. **General Mixer Info:**

   ```
   GET /inspect/mixerInfo
   ```

2. **Deposit History:**

   ```
   GET /inspect/depositHistory/{page}/{limit}
   ```

3. **Nullifier Status:**

   ```
   GET /inspect/nullifierStatus/{nullifierHash}
   ```

4. **Merkle Path:**

   ```
   GET /inspect/merklePath/{leafIndex}
   ```

5. **Health Check:**
   ```
   GET /inspect/healthCheck
   ```

## Security Considerations

- The mixer's security relies on the strength of the zero-knowledge proofs and the secrecy of user commitments.
- Always use a secure method to generate commitments and nullifiers.
- The emergency withdrawal function should only be used in critical situations as it may compromise user privacy.

## Disclaimer

This mixer is a proof-of-concept and should not be used with real funds without thorough auditing and testing. Use at your own risk.
