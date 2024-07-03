import _ from 'lodash';
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  StakingPoolFactory__factory,
  MockERC20__factory,
} from "../typechain";

const { provider } = ethers;

export const ONE_HOUR_IN_SECS = 60n * 60n;
export const ONE_DAY_IN_SECS = 24n * ONE_HOUR_IN_SECS;

export const nativeTokenAddress = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";


export async function deployContractsFixture() {
  const  [Alice, Bob, Caro, Dave]  = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory('MockERC20');
  const rewardTokenContract = await MockERC20.deploy('Mock RWD', 'RWD');
  const rewardToken = MockERC20__factory.connect(await rewardTokenContract.getAddress(), provider);

  const stakingTokenContract = await MockERC20.deploy('Mock STK', 'STK');
  const stakingToken = MockERC20__factory.connect(await stakingTokenContract.getAddress(), provider);

  const StakingPoolFactory = await ethers.getContractFactory('StakingPoolFactory');
  const stakingRewardsFactoryContract = await StakingPoolFactory.deploy(await rewardToken.getAddress());
  const stakingRewardsFactory = StakingPoolFactory__factory.connect(await stakingRewardsFactoryContract.getAddress(), provider);

  return { stakingRewardsFactory, stakingToken, rewardToken, Alice, Bob, Caro, Dave };
}

export function power(pow: number | bigint) {
  return 10n ** BigInt(pow);
}

export function abs(n: bigint) {
  return n < 0n ? -n : n;
}

export function expandTo18Decimals(n: number) {
  return BigInt(n) * (10n ** 18n);
}

// ensure result is within .01%
export function expectBigNumberEquals(expected: bigint, actual: bigint) {
  const equals = abs(expected - actual) <= abs(expected) * 2n / 10000n;
  if (!equals) {
    console.log(`BigNumber does not equal. expected: ${expected.toString()}, actual: ${actual.toString()}`);
  }
  expect(equals).to.be.true;
}
