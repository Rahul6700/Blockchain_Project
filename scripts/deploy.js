const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Account balance:",
    (await hre.ethers.provider.getBalance(deployer.address)).toString()
  );

  const LostFound = await hre.ethers.getContractFactory("LostFound");
  const contract = await LostFound.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("\nLostFound deployed to:", address);
  console.log("Note: No admin account. All transitions are trustless.");

  // Sync compiled artifact to the frontend utils directory
  const artifact = await hre.artifacts.readArtifact("LostFound");
  const frontendUtilsPath = path.join(
    __dirname, "..", "frontend", "src", "utils"
  );

  if (!fs.existsSync(frontendUtilsPath)) {
    fs.mkdirSync(frontendUtilsPath, { recursive: true });
  }

  fs.writeFileSync(
    path.join(frontendUtilsPath, "LostFound.json"),
    JSON.stringify(artifact, null, 2)
  );

  fs.writeFileSync(
    path.join(frontendUtilsPath, "deployedAddress.json"),
    JSON.stringify({ address, deployedAt: new Date().toISOString() }, null, 2)
  );

  console.log("\nABI synced  -> frontend/src/utils/LostFound.json");
  console.log("Address saved -> frontend/src/utils/deployedAddress.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
