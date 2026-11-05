import type { Registry } from "../engine";
import bayc from "./bayc";
import link from "./link";
import permit2 from "./permit2";
import railgun from "./railgun";
import stakingRegistry from "./staking-registry";
import tornado from "./tornado";
import uniswapV4 from "./uniswap-v4";
import uniswapV4Periphery from "./uniswap-v4-periphery";
import usdc from "./usdc";
import usdt from "./usdt";
import weth9 from "./weth9";

/** Order matters: `run --all` deploys in this order, and addresses depend on it. */
export const registry: Registry = {
  link,
  usdt,
  bayc,
  tornado,
  usdc,
  weth9,
  permit2,
  "uniswap-v4": uniswapV4,
  "uniswap-v4-periphery": uniswapV4Periphery,
  railgun,
  "staking-registry": stakingRegistry,
};
