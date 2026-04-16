# BlockFind — How to Run It (Single Wallet)

Use **one MetaMask account** for the whole demo. You do not need a second “owner” wallet: the same address can report an item, claim it with matching features (the contract allows that for testing), and confirm the handoff as the finder.

There is **no admin** on the blockchain. If your wallet is named “Admin” in MetaMask, that is only a **label** you chose — it does not grant any special power. Rename it to “Demo” if you prefer.

---

## 1. Install

```bash
npm install
cd frontend
npm install --legacy-peer-deps
cd ..
```

---

## 2. Start Hardhat (leave this terminal open)

```bash
npx hardhat node
```

---

## 3. Deploy the contract (new terminal)

```bash
npx hardhat run scripts/deploy.js --network localhost
```

Wait until you see the deployed address and that `deployedAddress.json` was written under `frontend/src/utils/`.

---

## 4. MetaMask on Hardhat

1. Add network:
   - **RPC:** `http://127.0.0.1:8545`
   - **Chain ID:** `31337`
   - **Symbol:** ETH  
2. Import **one** test key (from the `npx hardhat node` output). The first account is fine:

```
Private key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

3. After **every** restart of `npx hardhat node`, clear stuck nonces or transactions will fail:
   - MetaMask → **Settings → Advanced → Clear activity tab data** (for this account).

---

## 5. Start the app

```bash
cd frontend
npm start
```

Open **http://localhost:3000** → **Connect Wallet** → pick **Hardhat Localhost**.

---

## 6. Happy path (one wallet)

1. **Report**  
   - Description: e.g. `Blue backpack near Library B`  
   - Features: e.g. `torn zipper, red keychain, math notebook`  
   - Threshold: `2`  
   - Submit and confirm in MetaMask.

2. **Claim** (same wallet is OK for a demo)  
   - Find the card with status **REPORTED**.  
   - Type features that **exactly match** what you hashed at report time (same words, same commas/spaces — case-sensitive).  
   - Example: `torn zipper, red keychain`  
   - Submit and confirm.

3. **Confirm handoff**  
   - Status becomes **CLAIMED**.  
   - As the **finder** (you reported it), click **Confirm Physical Handoff** and confirm in MetaMask.

4. Status **RETURNED** — done.

---

## 7. If something fails

| Symptom | What to do |
|--------|------------|
| “Already claimed” / claim reverts | You clicked claim on an item that is no longer **Reported**, or the UI was stale. Click **Refresh** on the ledger. Only use the claim form on **REPORTED** cards. |
| “Nonce too high” | Clear activity tab data in MetaMask (step 4). Restarting Hardhat resets the chain but MetaMask keeps old nonces. |
| Claim denied (0 matches) | Features must match **exactly** what you typed when reporting (including spaces and capital letters). |
| Wrong network | Switch MetaMask to **Chain ID 31337**. |
| Contract not found banner | Run deploy again (step 3) with `hardhat node` still running. |

---

## 8. Command cheat sheet

```bash
# Terminal A
npx hardhat node

# Terminal B
npx hardhat run scripts/deploy.js --network localhost
cd frontend && npm start
```

---

## 9. On-chain roles (reminder)

| Step | Who |
|------|-----|
| Report | Anyone (becomes “finder” for that item) |
| Claim | Anyone — the contract checks feature hashes; no person approves it |
| Confirm return | **Only** the wallet that reported that item |

No separate admin account exists in the smart contract.
