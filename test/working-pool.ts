import _ from 'lodash';
import { ethers } from 'hardhat';
import { expect } from 'chai';
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { ONE_DAY_IN_SECS, deployContractsFixture, expandTo18Decimals, expectBigNumberEquals } from './utils';
import {
  WorkingPool__factory,
} from "../typechain";

const { provider } = ethers;

describe('Working Pool', () => {

  it('Basic scenario works', async () => {

    const { rewardToken, stakingToken, Alice, Bob, Caro, Dave } = await loadFixture(deployContractsFixture);

    const WorkingPool = await ethers.getContractFactory('WorkingPool');
    const WorkingPoolContract = await WorkingPool.deploy(await rewardToken.getAddress(), await stakingToken.getAddress());
    const pool = WorkingPool__factory.connect(await WorkingPoolContract.getAddress(), provider);

    // But user should be able to stake now (without rewards)
    await expect(stakingToken.connect(Alice).mint(Bob.address, expandTo18Decimals(10_000))).not.to.be.reverted;
    await expect(stakingToken.connect(Alice).mint(Caro.address, expandTo18Decimals(10_000))).not.to.be.reverted;

    let bobStakeAmount = expandTo18Decimals(9_000);
    await expect(stakingToken.connect(Bob).approve(await pool.getAddress(), bobStakeAmount)).not.to.be.reverted;
    await expect(pool.connect(Bob).stake(bobStakeAmount)).not.to.be.reverted;
    expect(await pool.totalSupply()).to.equal(bobStakeAmount);
    expect(await pool.balanceOf(Bob.address)).to.equal(bobStakeAmount);

    // No rewards now
    await time.increase(ONE_DAY_IN_SECS / 2n);
    expect(await pool.earned(Bob.address)).to.equal(0);

    // Dave accidently transfer some staking token to this contract
    const daveTransferAmount = expandTo18Decimals(100);
    await expect(stakingToken.connect(Alice).mint(Dave.address, daveTransferAmount)).not.to.be.reverted;
    await expect(stakingToken.connect(Dave).transfer(await pool.getAddress(), daveTransferAmount)).not.to.be.reverted;

    // Fast-forward to reward start time, and deposit 7_000_000 $RWD as reward (1_000_000 per day)
    const rewardStartTime = BigInt(await time.latest()) + ONE_DAY_IN_SECS;
    const rewardDurationInDays = 7n;
    await time.increaseTo(rewardStartTime);
    const totalReward = expandTo18Decimals(7_000_000);
    await expect(rewardToken.connect(Alice).mint(Alice.address, totalReward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await pool.getAddress(), totalReward)).not.to.be.reverted;
    await expect(pool.connect(Alice).addRewards(totalReward, rewardDurationInDays))
      .to.emit(pool, 'RewardAdded').withArgs(totalReward, rewardDurationInDays);
    // Note: The exact `reward start time` is the block timestamp of `addRewards` transaction,
    // which does not exactly equal to `rewardStartTime`
    expect(await pool.periodFinish()).to.equal(BigInt(await time.latest()) + ONE_DAY_IN_SECS * rewardDurationInDays);
    
    const caroStakeAmount = expandTo18Decimals(1_000);
    await expect(stakingToken.connect(Caro).approve(await pool.getAddress(), caroStakeAmount)).not.to.be.reverted;
    await expect(pool.connect(Caro).stake(caroStakeAmount)).not.to.be.reverted;
    expect(await pool.totalSupply()).to.equal(bobStakeAmount + caroStakeAmount);
    expect(await pool.balanceOf(Caro.address)).to.equal(caroStakeAmount);

    // 1_000_000 $RWD per day. Fast-forward to generate rewards
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS);
    const totalRewardPerDay = totalReward / BigInt(rewardDurationInDays);
    expectBigNumberEquals(totalRewardPerDay * 9n / 10n, await pool.earned(Bob.address));
    expectBigNumberEquals(totalRewardPerDay / 10n, await pool.earned(Caro.address));

    // Dave has no rewards
    expect(await pool.balanceOf(Dave.address)).to.equal(0);
    expect(await pool.earned(Dave.address)).to.equal(0);

    // Caro claim $RWD rewards
    await expect(pool.connect(Caro).getReward())
      .to.emit(pool, 'RewardPaid').withArgs(Caro.address, anyValue);
    expect(await pool.earned(Caro.address)).to.equal(0);
    expectBigNumberEquals(await rewardToken.balanceOf(Caro.address), totalRewardPerDay / 10n);

    // Fast-forward 1 day. Bob's reward: 9/10 + 9/10;  Caro's reward: 1/10
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 2n);
    expectBigNumberEquals(totalRewardPerDay * 18n / 10n, await pool.earned(Bob.address));
    expectBigNumberEquals(totalRewardPerDay / 10n, await pool.earned(Caro.address));

    // Bob withdraw part of his staking coin
    const bobWithdrawAmount = expandTo18Decimals(5000);
    bobStakeAmount = expandTo18Decimals(9000 - 5000);
    // Now Bob's effective staking is 4000 and Caro's effective staking is 1000
    await expect(pool.connect(Bob).withdraw(expandTo18Decimals(10_000))).to.be.reverted;
    await expect(pool.connect(Bob).withdraw(bobWithdrawAmount))
      .to.emit(pool, 'Withdrawn').withArgs(Bob.address, bobWithdrawAmount);
    expect(await pool.totalSupply()).to.equal(bobStakeAmount + caroStakeAmount);
    expect(await pool.balanceOf(Bob.address)).to.equal(bobStakeAmount);
    expect(await pool.balanceOf(Caro.address)).to.equal(caroStakeAmount);
    
    // Fast-forward 1 day. Bob's reward: 9/10 + 9/10 + 8/10;  Caro's reward: 1/10 + 2/10
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 3n);
    expectBigNumberEquals(totalRewardPerDay * 26n / 10n, await pool.earned(Bob.address));
    expectBigNumberEquals(totalRewardPerDay * 3n / 10n, await pool.earned(Caro.address));

    // 4 days remaining. Now admin could start another round of rewarding, withd different duration, like 14 days.
    // Remaining days are extended to 14;  Reward per day from now on: (7_000_000 * 4 / 7  + 14_000_000) / 14
    const round2DurationInDays = 14n;
    const round2TotalReward = expandTo18Decimals(14_000_000);
    const round2TotalRewardPerDay = (totalReward * 4n / 7n + round2TotalReward) / BigInt(round2DurationInDays);
    await expect(rewardToken.connect(Alice).mint(Alice.address, round2TotalReward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await pool.getAddress(), round2TotalReward)).not.to.be.reverted;
    await expect(pool.connect(Alice).addRewards(round2TotalReward, round2DurationInDays))
      .to.emit(pool, 'RewardAdded').withArgs(round2TotalReward, round2DurationInDays);
    expect(await pool.periodFinish()).to.equal(BigInt(await time.latest()) + ONE_DAY_IN_SECS * round2DurationInDays);

    // Fast-forward 1 day. Now every day, Bob get 8/10 rewards, and Caro get 2/10 rewards
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 4n);
    const round1BobReward = totalRewardPerDay * 26n / 10n;
    const round2CaroReward = totalRewardPerDay * 3n / 10n;
    expectBigNumberEquals(round1BobReward + (round2TotalRewardPerDay * 8n / 10n), await pool.earned(Bob.address));
    expectBigNumberEquals(round2CaroReward + (round2TotalRewardPerDay * 2n / 10n), await pool.earned(Caro.address));

    // Caro exit staking
    await expect(pool.connect(Caro).exit())
      .to.emit(pool, 'Withdrawn').withArgs(Caro.address, caroStakeAmount)
      .to.emit(pool, 'RewardPaid').withArgs(Caro.address, anyValue);
    expect(await pool.totalSupply()).to.equal(bobStakeAmount);
    expect(await pool.balanceOf(Bob.address)).to.equal(bobStakeAmount);
    expect(await pool.balanceOf(Caro.address)).to.equal(0);
  
    // Now bob get all the staking rewards
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 5n);
    expectBigNumberEquals(round1BobReward + (round2TotalRewardPerDay * 18n / 10n), await pool.earned(Bob.address));
    
    // Fast-forward to round 2 finish
    await time.increaseTo(await pool.periodFinish());
    const bobRewardsTillRound2 = round1BobReward + (round2TotalRewardPerDay * 138n / 10n);
    expectBigNumberEquals(bobRewardsTillRound2, await pool.earned(Bob.address));

    // // Fast-forward 1 more day. No extra rewards are generated
    await time.increaseTo((await pool.periodFinish()) + BigInt(ONE_DAY_IN_SECS));
    expectBigNumberEquals(bobRewardsTillRound2, await pool.earned(Bob.address));

    // Admin start round 3 for 3 day only
    const round3DurationInDays = 3n;
    const round3TotalReward = expandTo18Decimals(3_000_000);
    const round3TotalRewardPerDay = round3TotalReward / (round3DurationInDays);
    await expect(rewardToken.connect(Alice).mint(Alice.address, round3TotalReward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await pool.getAddress(), round3TotalReward)).not.to.be.reverted;
    await expect(pool.connect(Alice).addRewards(round3TotalReward, round3DurationInDays))
      .to.emit(pool, 'RewardAdded').withArgs(round3TotalReward, round3DurationInDays);
    expect(await pool.periodFinish()).to.equal(BigInt(await time.latest())+ ONE_DAY_IN_SECS * round3DurationInDays);

    // Fast-forward 1 more day. Bob gets all the reward
    await time.increase(ONE_DAY_IN_SECS);
    expectBigNumberEquals(bobRewardsTillRound2 + round3TotalRewardPerDay, await pool.earned(Bob.address));

    // Fast-forward to period finish
    await time.increaseTo(await pool.periodFinish());

    // Bob should be able to exit
    await expect(pool.connect(Bob).exit())
      .to.emit(pool, 'Withdrawn').withArgs(Bob.address, anyValue)
      .to.emit(pool, 'RewardPaid').withArgs(Bob.address, anyValue);
    expect(await pool.totalSupply()).to.equal(0);
    expect(await pool.balanceOf(Bob.address)).to.equal(0);
  });

});