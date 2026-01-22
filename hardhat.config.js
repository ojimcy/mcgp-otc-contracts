require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        version: "0.8.20",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
        },
    },
    networks: {
        hardhat: {
            chainId: 1337,
        },
        sonic: {
            url: process.env.SONIC_RPC_URL || "https://rpc.soniclabs.com",
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
            chainId: 146, // Sonic mainnet chain ID
        },
        sonicTestnet: {
            url: process.env.SONIC_TESTNET_RPC_URL || "https://rpc.testnet.soniclabs.com",
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
            chainId: 14601, // Sonic Blaze testnet chain ID
        },
    },
    etherscan: {
        apiKey: {
            sonic: process.env.ETHERSCAN_API_KEY || "sonic",
            sonicTestnet: process.env.ETHERSCAN_API_KEY || "sonic",
        },
        customChains: [
            {
                network: "sonic",
                chainId: 146,
                urls: {
                    apiURL: "https://api.etherscan.io/v2/api?chainid=146",
                    browserURL: "https://sonicscan.org",
                },
            },
            {
                network: "sonicTestnet",
                chainId: 14601,
                urls: {
                    apiURL: "https://api.etherscan.io/v2/api?chainid=14601",
                    browserURL: "https://testnet.sonicscan.org",
                },
            },
        ],
    },
};
