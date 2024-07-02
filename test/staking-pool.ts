import _ from 'lodash';
import { ethers } from 'hardhat';
import { expect } from 'chai';
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { ONE_DAY_IN_SECS, deployContractsFixture, expandTo18Decimals, expectBigNumberEquals } from './utils';
import {
  StakingRewards__factory,
  StakingRewardsFactory__factory,
} from "../typechain";

const { provider } = ethers;

describe('StakingRewards Pool', () => {

  it('Basic scenario works', async () => {

    const { stakingRewardsFactory, rewardToken, stakingToken, Alice, Bob, Caro, Dave } = await loadFixture(deployContractsFixture);

    // Deploy a farm
    await expect(stakingRewardsFactory.connect(Alice).deploy(await stakingToken.getAddress())).not.to.be.reverted;
    const erc20Farm = StakingRewards__factory.connect(await stakingRewardsFactory.getStakingPoolAddress(await stakingToken.getAddress()), provider);

    // But user should be able to stake now (without rewards)
    await expect(stakingToken.connect(Alice).mint(Bob.address, expandTo18Decimals(10_000))).not.to.be.reverted;
    await expect(stakingToken.connect(Alice).mint(Caro.address, expandTo18Decimals(10_000))).not.to.be.reverted;

    let bobStakeAmount = expandTo18Decimals(9_000);
    await expect(stakingToken.connect(Bob).approve(await erc20Farm.getAddress(), bobStakeAmount)).not.to.be.reverted;
    await expect(erc20Farm.connect(Bob).stake(bobStakeAmount)).not.to.be.reverted;
    expect(await erc20Farm.totalSupply()).to.equal(bobStakeAmount);
    expect(await erc20Farm.balanceOf(Bob.address)).to.equal(bobStakeAmount);

    // No rewards now
    await time.increase(ONE_DAY_IN_SECS / 2n);
    expect(await erc20Farm.earned(Bob.address)).to.equal(0);

    // Dave accidently transfer some staking token to this contract
    const daveTransferAmount = expandTo18Decimals(100);
    await expect(stakingToken.connect(Alice).mint(Dave.address, daveTransferAmount)).not.to.be.reverted;
    await expect(stakingToken.connect(Dave).transfer(await erc20Farm.getAddress(), daveTransferAmount)).not.to.be.reverted;

    // Fast-forward to reward start time, and deposit 7_000_000 $RWD as reward (1_000_000 per day)
    const rewardStartTime = BigInt(await time.latest()) + ONE_DAY_IN_SECS;
    const rewardDurationInDays = 7n;
    await time.increaseTo(rewardStartTime);
    const totalReward = expandTo18Decimals(7_000_000);
    await expect(rewardToken.connect(Alice).mint(Alice.address, totalReward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await stakingRewardsFactory.getAddress(), totalReward)).not.to.be.reverted;
    await expect(stakingRewardsFactory.connect(Alice).addRewards(await stakingToken.getAddress(), totalReward, rewardDurationInDays))
      .to.emit(erc20Farm, 'RewardAdded').withArgs(totalReward, rewardDurationInDays);
    // Note: The exact `reward start time` is the block timestamp of `addRewards` transaction,
    // which does not exactly equal to `rewardStartTime`
    expect(await erc20Farm.periodFinish()).to.equal(BigInt(await time.latest()) + ONE_DAY_IN_SECS * rewardDurationInDays);
    expect((await stakingRewardsFactory.stakingRewardsInfoByStakingToken(await stakingToken.getAddress())).totalRewardsAmount).to.equal(totalReward);
    
    const caroStakeAmount = expandTo18Decimals(1_000);
    await expect(stakingToken.connect(Caro).approve(await erc20Farm.getAddress(), caroStakeAmount)).not.to.be.reverted;
    await expect(erc20Farm.connect(Caro).stake(caroStakeAmount)).not.to.be.reverted;
    expect(await erc20Farm.totalSupply()).to.equal(bobStakeAmount + caroStakeAmount);
    expect(await erc20Farm.balanceOf(Caro.address)).to.equal(caroStakeAmount);

    // 1_000_000 $RWD per day. Fast-forward to generate rewards
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS);
    const totalRewardPerDay = totalReward / BigInt(rewardDurationInDays);
    expectBigNumberEquals(totalRewardPerDay * 9n / 10n, await erc20Farm.earned(Bob.address));
    expectBigNumberEquals(totalRewardPerDay / 10n, await erc20Farm.earned(Caro.address));

    // Dave has no rewards
    expect(await erc20Farm.balanceOf(Dave.address)).to.equal(0);
    expect(await erc20Farm.earned(Dave.address)).to.equal(0);

    // Caro claim $RWD rewards
    await expect(erc20Farm.connect(Caro).getReward())
      .to.emit(erc20Farm, 'RewardPaid').withArgs(Caro.address, anyValue);
    expect(await erc20Farm.earned(Caro.address)).to.equal(0);
    expectBigNumberEquals(await rewardToken.balanceOf(Caro.address), totalRewardPerDay / 10n);

    // Fast-forward 1 day. Bob's reward: 9/10 + 9/10;  Caro's reward: 1/10
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 2n);
    expectBigNumberEquals(totalRewardPerDay * 18n / 10n, await erc20Farm.earned(Bob.address));
    expectBigNumberEquals(totalRewardPerDay / 10n, await erc20Farm.earned(Caro.address));

    // Bob withdraw part of his staking coin
    const bobWithdrawAmount = expandTo18Decimals(5000);
    bobStakeAmount = expandTo18Decimals(9000 - 5000);
    // Now Bob's effective staking is 4000 and Caro's effective staking is 1000
    await expect(erc20Farm.connect(Bob).withdraw(expandTo18Decimals(10_000))).to.be.reverted;
    await expect(erc20Farm.connect(Bob).withdraw(bobWithdrawAmount))
      .to.emit(erc20Farm, 'Withdrawn').withArgs(Bob.address, bobWithdrawAmount);
    expect(await erc20Farm.totalSupply()).to.equal(bobStakeAmount + caroStakeAmount);
    expect(await erc20Farm.balanceOf(Bob.address)).to.equal(bobStakeAmount);
    expect(await erc20Farm.balanceOf(Caro.address)).to.equal(caroStakeAmount);
    
    // Fast-forward 1 day. Bob's reward: 9/10 + 9/10 + 8/10;  Caro's reward: 1/10 + 2/10
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 3n);
    expectBigNumberEquals(totalRewardPerDay * 26n / 10n, await erc20Farm.earned(Bob.address));
    expectBigNumberEquals(totalRewardPerDay * 3n / 10n, await erc20Farm.earned(Caro.address));

    // 4 days remaining. Now admin could start another round of rewarding, withd different duration, like 14 days.
    // Remaining days are extended to 14;  Reward per day from now on: (7_000_000 * 4 / 7  + 14_000_000) / 14
    const round2DurationInDays = 14n;
    const round2TotalReward = expandTo18Decimals(14_000_000);
    const round2TotalRewardPerDay = (totalReward * 4n / 7n + round2TotalReward) / BigInt(round2DurationInDays);
    await expect(rewardToken.connect(Alice).mint(Alice.address, round2TotalReward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await stakingRewardsFactory.getAddress(), round2TotalReward)).not.to.be.reverted;
    await expect(stakingRewardsFactory.connect(Alice).addRewards(await stakingToken.getAddress(), round2TotalReward, round2DurationInDays))
      .to.emit(erc20Farm, 'RewardAdded').withArgs(round2TotalReward, round2DurationInDays);
    expect(await erc20Farm.periodFinish()).to.equal(BigInt(await time.latest()) + ONE_DAY_IN_SECS * round2DurationInDays);
    expect((await stakingRewardsFactory.stakingRewardsInfoByStakingToken(await stakingToken.getAddress())).totalRewardsAmount).to.equal(totalReward + round2TotalReward);

    // Fast-forward 1 day. Now every day, Bob get 8/10 rewards, and Caro get 2/10 rewards
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 4n);
    const round1BobReward = totalRewardPerDay * 26n / 10n;
    const round2CaroReward = totalRewardPerDay * 3n / 10n;
    expectBigNumberEquals(round1BobReward + (round2TotalRewardPerDay * 8n / 10n), await erc20Farm.earned(Bob.address));
    expectBigNumberEquals(round2CaroReward + (round2TotalRewardPerDay * 2n / 10n), await erc20Farm.earned(Caro.address));

    // Caro exit staking
    await expect(erc20Farm.connect(Caro).exit())
      .to.emit(erc20Farm, 'Withdrawn').withArgs(Caro.address, caroStakeAmount)
      .to.emit(erc20Farm, 'RewardPaid').withArgs(Caro.address, anyValue);
    expect(await erc20Farm.totalSupply()).to.equal(bobStakeAmount);
    expect(await erc20Farm.balanceOf(Bob.address)).to.equal(bobStakeAmount);
    expect(await erc20Farm.balanceOf(Caro.address)).to.equal(0);
  
    // Now bob get all the staking rewards
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 5n);
    expectBigNumberEquals(round1BobReward + (round2TotalRewardPerDay * 18n / 10n), await erc20Farm.earned(Bob.address));
    
    // Fast-forward to round 2 finish
    await time.increaseTo(await erc20Farm.periodFinish());
    const bobRewardsTillRound2 = round1BobReward + (round2TotalRewardPerDay * 138n / 10n);
    expectBigNumberEquals(bobRewardsTillRound2, await erc20Farm.earned(Bob.address));

    // // Fast-forward 1 more day. No extra rewards are generated
    await time.increaseTo((await erc20Farm.periodFinish()) + BigInt(ONE_DAY_IN_SECS));
    expectBigNumberEquals(bobRewardsTillRound2, await erc20Farm.earned(Bob.address));

    // Admin start round 3 for 3 day only
    const round3DurationInDays = 3n;
    const round3TotalReward = expandTo18Decimals(3_000_000);
    const round3TotalRewardPerDay = round3TotalReward / (round3DurationInDays);
    await expect(rewardToken.connect(Alice).mint(Alice.address, round3TotalReward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await stakingRewardsFactory.getAddress(), round3TotalReward)).not.to.be.reverted;
    await expect(stakingRewardsFactory.connect(Alice).addRewards(await stakingToken.getAddress(), round3TotalReward, round3DurationInDays))
      .to.emit(erc20Farm, 'RewardAdded').withArgs(round3TotalReward, round3DurationInDays);
    expect(await erc20Farm.periodFinish()).to.equal(BigInt(await time.latest())+ ONE_DAY_IN_SECS * round3DurationInDays);
    expect((await stakingRewardsFactory.stakingRewardsInfoByStakingToken(await stakingToken.getAddress())).totalRewardsAmount).to.equal(totalReward + round2TotalReward + round3TotalReward);

    // Fast-forward 1 more day. Bob gets all the reward
    await time.increase(ONE_DAY_IN_SECS);
    expectBigNumberEquals(bobRewardsTillRound2 + round3TotalRewardPerDay, await erc20Farm.earned(Bob.address));

    // Fast-forward to period finish
    await time.increaseTo(await erc20Farm.periodFinish());

    // Bob should be able to exit
    await expect(erc20Farm.connect(Bob).exit())
      .to.emit(erc20Farm, 'Withdrawn').withArgs(Bob.address, anyValue)
      .to.emit(erc20Farm, 'RewardPaid').withArgs(Bob.address, anyValue);
    expect(await erc20Farm.totalSupply()).to.equal(0);
    expect(await erc20Farm.balanceOf(Bob.address)).to.equal(0);
  });

  it('Discontinued staking works', async () => {

    const { rewardToken, stakingRewardsFactory, stakingToken, Alice, Bob, Caro } = await loadFixture(deployContractsFixture);

    // Deploy a staking pool, starting 1 day later, and lasts for 7 days
    const rewardStartTime = BigInt(await time.latest()) + ONE_DAY_IN_SECS;
    const rewardDurationInDays = 7n;
    await expect(stakingRewardsFactory.connect(Alice).deploy(await stakingToken.getAddress())).not.to.be.reverted;
    const erc20Farm = StakingRewards__factory.connect(await stakingRewardsFactory.getStakingPoolAddress(await stakingToken.getAddress()), provider);
  
    await expect(stakingToken.connect(Alice).mint(Bob.address, expandTo18Decimals(10_000))).not.to.be.reverted;
    await expect(stakingToken.connect(Alice).mint(Caro.address, expandTo18Decimals(10_000))).not.to.be.reverted;

    // Fast-forward to reward start time, and deposit 7_000_000 $RWD as reward (1_000_000 per day)
    await time.increaseTo(rewardStartTime);
    const totalReward = expandTo18Decimals(7_000_000);
    await expect(rewardToken.connect(Alice).mint(Alice.address, totalReward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await stakingRewardsFactory.getAddress(), totalReward)).not.to.be.reverted;
    await expect(stakingRewardsFactory.connect(Alice).addRewards(await stakingToken.getAddress(), totalReward, rewardDurationInDays))
      .to.emit(erc20Farm, 'RewardAdded').withArgs(totalReward, rewardDurationInDays);
    // Note: The exact `reward start time` is the block timestamp of `addRewards` transaction,
    // which does not exactly equal to `rewardStartTime`
    expect(await erc20Farm.periodFinish()).to.equal(BigInt(await time.latest()) + ONE_DAY_IN_SECS * rewardDurationInDays);
    expect((await stakingRewardsFactory.stakingRewardsInfoByStakingToken(await stakingToken.getAddress())).totalRewardsAmount).to.equal(totalReward);
    
    // Fast-forward by one day, with no staking
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS);
    expect(await erc20Farm.totalSupply()).to.equal(0);

    let bobStakeAmount = expandTo18Decimals(1_000);
    await expect(stakingToken.connect(Bob).approve(await erc20Farm.getAddress(), bobStakeAmount)).not.to.be.reverted;
    await expect(erc20Farm.connect(Bob).stake(bobStakeAmount)).not.to.be.reverted;
    expect(await erc20Farm.totalSupply()).to.equal(bobStakeAmount);
    expect(await erc20Farm.balanceOf(Bob.address)).to.equal(bobStakeAmount);

    // Fast-forward by one day
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 2n);

    // Bob should get 1 day reward
    const totalRewardPerDay = totalReward / rewardDurationInDays;
    expectBigNumberEquals(totalRewardPerDay, await erc20Farm.earned(Bob.address));

    // Fast-forward to end
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 8n);

    // Bob exit
    await expect(erc20Farm.connect(Bob).exit())
      .to.emit(erc20Farm, 'Withdrawn').withArgs(Bob.address, anyValue)
      .to.emit(erc20Farm, 'RewardPaid').withArgs(Bob.address, anyValue);
    expect(await erc20Farm.totalSupply()).to.equal(0);
    expect(await erc20Farm.balanceOf(Bob.address)).to.equal(0);

    // 1 day rewards remains in the pool
    expectBigNumberEquals(totalRewardPerDay, await rewardToken.balanceOf(await erc20Farm.getAddress()));
  });

  it('Discontinued reward works', async () => {

    const { rewardToken, stakingRewardsFactory, stakingToken, Alice, Bob, Caro } = await loadFixture(deployContractsFixture);

    // Deploy a staking pool, starting 1 day later, and lasts for 1 days
    const rewardStartTime = BigInt(await time.latest()) + ONE_DAY_IN_SECS;
    const rewardDurationInDays = 1n;
    await expect(stakingRewardsFactory.connect(Alice).deploy(await stakingToken.getAddress())).not.to.be.reverted;
    const erc20Farm = StakingRewards__factory.connect(await stakingRewardsFactory.getStakingPoolAddress(await stakingToken.getAddress()), provider);
  
    await expect(stakingToken.connect(Alice).mint(Bob.address, expandTo18Decimals(10_000))).not.to.be.reverted;
    await expect(stakingToken.connect(Alice).mint(Caro.address, expandTo18Decimals(10_000))).not.to.be.reverted;

    // Bob stakes 800 $RWD, and Caro stakes 200 $RWD
    let bobStakeAmount = expandTo18Decimals(800);
    let caroStakeAmount = expandTo18Decimals(200);
    await expect(stakingToken.connect(Bob).approve(await erc20Farm.getAddress(), bobStakeAmount)).not.to.be.reverted;
    await expect(erc20Farm.connect(Bob).stake(bobStakeAmount)).not.to.be.reverted;
    await expect(stakingToken.connect(Caro).approve(await erc20Farm.getAddress(), caroStakeAmount)).not.to.be.reverted;
    await expect(erc20Farm.connect(Caro).stake(caroStakeAmount)).not.to.be.reverted;
    expect(await erc20Farm.totalSupply()).to.equal(bobStakeAmount + caroStakeAmount);

    // Fast-forward to reward start time, and deposit 1_000_000 $RWD as reward (1_000_000 per day)
    await time.increaseTo(rewardStartTime);
    const totalReward = expandTo18Decimals(1_000_000);
    await expect(rewardToken.connect(Alice).mint(Alice.address, totalReward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await stakingRewardsFactory.getAddress(), totalReward)).not.to.be.reverted;
    await expect(stakingRewardsFactory.connect(Alice).addRewards(await stakingToken.getAddress(), totalReward, rewardDurationInDays))
      .to.emit(erc20Farm, 'RewardAdded').withArgs(totalReward, rewardDurationInDays);
    // Note: The exact `reward start time` is the block timestamp of `addRewards` transaction,
    // which does not exactly equal to `rewardStartTime`
    expect(await erc20Farm.periodFinish()).to.equal(BigInt(await time.latest()) + ONE_DAY_IN_SECS * rewardDurationInDays);
    expect((await stakingRewardsFactory.stakingRewardsInfoByStakingToken(await stakingToken.getAddress())).totalRewardsAmount).to.equal(totalReward);

    // Fast-forward to Day 2. Reward perioid finish
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 2n);

    // Bob should get 4/5 rewards, and Caro should get 1/5 rewards
    expectBigNumberEquals(totalReward * 4n / 5n, await erc20Farm.earned(Bob.address));
    expectBigNumberEquals(totalReward / 5n, await erc20Farm.earned(Caro.address));

    // Bob claim rewards
    await expect(erc20Farm.connect(Bob).getReward())
      .to.emit(erc20Farm, 'RewardPaid').withArgs(Bob.address, anyValue);
    
    // Fast-forward to Day 5, and start another round of reward
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 5n);
    const round2Reward = expandTo18Decimals(2_000_000);
    await expect(rewardToken.connect(Alice).mint(Alice.address, round2Reward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await stakingRewardsFactory.getAddress(), round2Reward)).not.to.be.reverted;
    await expect(stakingRewardsFactory.connect(Alice).addRewards(await stakingToken.getAddress(), round2Reward, rewardDurationInDays))
      .to.emit(erc20Farm, 'RewardAdded').withArgs(round2Reward, rewardDurationInDays);
    expect((await stakingRewardsFactory.stakingRewardsInfoByStakingToken(await stakingToken.getAddress())).totalRewardsAmount).to.equal(totalReward + round2Reward);

    // Fast-forward to Day 7. Bob should get 4/5 rewards, and Caro should get 1/5 rewards
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 7n);
    expectBigNumberEquals(round2Reward * 4n / 5n, await erc20Farm.earned(Bob.address));
    expectBigNumberEquals(totalReward / 5n + round2Reward / 5n, await erc20Farm.earned(Caro.address));
  });

  it('Staking round could be terminated ahead of schedule', async () => {

    const { rewardToken, stakingRewardsFactory, stakingToken, Alice, Bob, Caro } = await loadFixture(deployContractsFixture);

    await expect(stakingRewardsFactory.connect(Alice).deploy(await stakingToken.getAddress())).not.to.be.reverted;
    const erc20Farm = StakingRewards__factory.connect(await stakingRewardsFactory.getStakingPoolAddress(await stakingToken.getAddress()), provider);
  
    await expect(stakingToken.connect(Alice).mint(Bob.address, expandTo18Decimals(10_000))).not.to.be.reverted;
    await expect(stakingToken.connect(Alice).mint(Caro.address, expandTo18Decimals(10_000))).not.to.be.reverted;

    let bobStakeAmount = expandTo18Decimals(1_000);
    await expect(stakingToken.connect(Bob).approve(await erc20Farm.getAddress(), bobStakeAmount)).not.to.be.reverted;
    await expect(erc20Farm.connect(Bob).stake(bobStakeAmount)).not.to.be.reverted;
    expect(await erc20Farm.totalSupply()).to.equal(bobStakeAmount);
    expect(await erc20Farm.balanceOf(Bob.address)).to.equal(bobStakeAmount);

    // Deposit 7_000_000 $RWD as reward (1_000_000 per day). Last for 7 days
    const rewardStartTime = BigInt(await time.latest()) + ONE_DAY_IN_SECS;
    const rewardDurationInDays = 7n;
    await time.increaseTo(rewardStartTime);
    const totalReward = expandTo18Decimals(7_000_000);
    const totalRewardPerDay = totalReward / rewardDurationInDays;
    await expect(rewardToken.connect(Alice).mint(Alice.address, totalReward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await stakingRewardsFactory.getAddress(), totalReward)).not.to.be.reverted;
    await expect(stakingRewardsFactory.connect(Alice).addRewards(await stakingToken.getAddress(), totalReward, rewardDurationInDays))
      .to.emit(erc20Farm, 'RewardAdded').withArgs(totalReward, rewardDurationInDays);
    // Note: The exact `reward start time` is the block timestamp of `addRewards` transaction,
    // which does not exactly equal to `rewardStartTime`
    expect(await erc20Farm.periodFinish()).to.equal(BigInt(await time.latest()) + ONE_DAY_IN_SECS * rewardDurationInDays);
    expect((await stakingRewardsFactory.stakingRewardsInfoByStakingToken(await stakingToken.getAddress())).totalRewardsAmount).to.equal(totalReward);
    
    // Fast-forward by 2 days, Bob get all the rewards
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 2n);
    expectBigNumberEquals(totalRewardPerDay * 2n, await erc20Farm.earned(Bob.address));
    // expect(await erc20Farm.totalSupply()).to.equal(0);

    // 2 days passed, 5 days remaining. Now we start new a new round, but limit the time to 1 day only
    const round2DurationInDays = 1n;
    const round2Rewards = expandTo18Decimals(1_000_000);
    await expect(rewardToken.connect(Alice).mint(Alice.address, round2Rewards)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await stakingRewardsFactory.getAddress(), round2Rewards)).not.to.be.reverted;
    await expect(stakingRewardsFactory.connect(Alice).addRewards(await stakingToken.getAddress(), round2Rewards, round2DurationInDays))
      .to.emit(erc20Farm, 'RewardAdded').withArgs(round2Rewards, round2DurationInDays);

    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 3n);
    const round2RewardPerDay = totalRewardPerDay * 5n + (round2Rewards / round2DurationInDays);
    expectBigNumberEquals(totalRewardPerDay * 2n + round2RewardPerDay, await erc20Farm.earned(Bob.address));

    // Reward finish. Fast forward, no more rewards
    await time.increaseTo(rewardStartTime + ONE_DAY_IN_SECS * 4n);
    expectBigNumberEquals(totalRewardPerDay * 2n + round2RewardPerDay, await erc20Farm.earned(Bob.address));

    // Bob exit
    await expect(erc20Farm.connect(Bob).exit())
      .to.emit(erc20Farm, 'Withdrawn').withArgs(Bob.address, anyValue)
      .to.emit(erc20Farm, 'RewardPaid').withArgs(Bob.address, anyValue);
    expect(await erc20Farm.totalSupply()).to.equal(0);
    expect(await erc20Farm.balanceOf(Bob.address)).to.equal(0);
  });

  it('Deploying Farm fails if called twice for same token', async () => {

    const { stakingRewardsFactory, stakingToken, Alice } = await loadFixture(deployContractsFixture);

    await expect(stakingRewardsFactory.connect(Alice).deploy(await stakingToken.getAddress())).not.to.be.reverted;

    await expect(stakingRewardsFactory.connect(Alice).deploy(await stakingToken.getAddress()))
      .to.be.rejectedWith(
        /StakingRewardsFactory::deploy: already deployed/,
      );

  });

  it('Deploying Farm can only be called by the owner', async () => {

    const { stakingRewardsFactory, stakingToken, Bob } = await loadFixture(deployContractsFixture);

    await expect(stakingRewardsFactory.connect(Bob).deploy(await stakingToken.getAddress()))
      .to.be.rejectedWith(
        /Ownable: caller is not the owner/,
      );

  });

  it('Ownership and rewardership can be managed', async () => {
    const { rewardToken, stakingRewardsFactory, stakingToken, Alice, Bob } = await loadFixture(deployContractsFixture);

    // Bob should fail to deploy a pool
    const rewardStartTime = BigInt(await time.latest()) + ONE_DAY_IN_SECS;
    const rewardDurationInDays = 7;
    await expect(stakingRewardsFactory.connect(Bob).deploy(await stakingToken.getAddress()))
      .to.be.rejectedWith(/Ownable: caller is not the owner/);

    // Alice transfer ownership to Bob
    await expect(stakingRewardsFactory.connect(Alice).transferOwnership(Bob.address))
      .to.emit(stakingRewardsFactory, 'OwnershipTransferred').withArgs(Alice.address, Bob.address);

    // Alice lose ownership
    await expect(stakingRewardsFactory.connect(Alice).deploy(await stakingToken.getAddress()))
      .to.be.rejectedWith(/Ownable: caller is not the owner/);

    // Bob should be able to call admin functions
    await expect(stakingRewardsFactory.connect(Bob).deploy(await stakingToken.getAddress()))
      .to.emit(stakingRewardsFactory, 'StakingPoolDeployed').withArgs(anyValue, await stakingToken.getAddress());
    const erc20Farm = StakingRewards__factory.connect(await stakingRewardsFactory.getStakingPoolAddress(await stakingToken.getAddress()), provider);

    const totalReward = expandTo18Decimals(1_000_000);
    await expect(rewardToken.connect(Alice).mint(Alice.address, totalReward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).mint(Bob.address, totalReward)).not.to.be.reverted;

    await time.increaseTo(rewardStartTime);
    await expect(rewardToken.connect(Alice).approve(await stakingRewardsFactory.getAddress(), totalReward)).not.to.be.reverted;
    await expect(rewardToken.connect(Bob).approve(await stakingRewardsFactory.getAddress(), totalReward)).not.to.be.reverted;

    // Alice is still a rewarder, could add rewards
    await expect(stakingRewardsFactory.connect(Alice).addRewards(await stakingToken.getAddress(), totalReward, rewardDurationInDays)).not.to.be.rejected;

    // Bos is now the owner, but is not a rewarder
    await expect(stakingRewardsFactory.connect(Bob).addRewards(await stakingToken.getAddress(), totalReward, rewardDurationInDays))
      .to.be.rejectedWith(/Not a rewarder/);
    
    await expect(stakingRewardsFactory.connect(Bob).addRewarder(Bob.address))
      .to.emit(stakingRewardsFactory, 'RewarderAdded').withArgs(Bob.address);

    await expect(stakingRewardsFactory.connect(Bob).addRewards(await stakingToken.getAddress(), expandTo18Decimals(500_000), rewardDurationInDays))
      .to.emit(erc20Farm, 'RewardAdded').withArgs(expandTo18Decimals(500_000), rewardDurationInDays);

    await expect(stakingRewardsFactory.connect(Bob).removeRewarder(Bob.address))
      .to.emit(stakingRewardsFactory, 'RewarderRemoved').withArgs(Bob.address);

    await expect(stakingRewardsFactory.connect(Bob).addRewards(await stakingToken.getAddress(), expandTo18Decimals(500_000), rewardDurationInDays))
      .to.be.rejectedWith(/Not a rewarder/);
  });

});