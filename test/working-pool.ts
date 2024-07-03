import _ from 'lodash';
import { ethers } from 'hardhat';
import { expect } from 'chai';
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { ONE_HOUR_IN_SECS, ONE_DAY_IN_SECS, deployContractsFixture, expectBigNumberEquals } from './utils';
import {
  WorkingPool__factory,
} from "../typechain";

const { provider } = ethers;

describe('Working Pool', () => {

  it('Basic scenario works', async () => {

    const { rewardToken, Alice, Bob, Caro, Dave } = await loadFixture(deployContractsFixture);

    // Distribute 18 $RWD over 180 days. Workers must submit their report at most every 1 hour
    const totalRewards = ethers.parseUnits('18', await rewardToken.decimals());
    const rewardsDuration = ONE_DAY_IN_SECS * 180n;
    const maxReportSpan = ONE_HOUR_IN_SECS;

    const WorkingPool = await ethers.getContractFactory('WorkingPool');
    const WorkingPoolContract = await WorkingPool.deploy(await rewardToken.getAddress());
    const pool = WorkingPool__factory.connect(await WorkingPoolContract.getAddress(), provider);

    // Cann't register before initialize
    await expect(pool.connect(Alice).register()).to.be.revertedWith('not initialized');

    // Initialize
    await expect(rewardToken.connect(Alice).mint(await Alice.getAddress(), totalRewards)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await pool.getAddress(), totalRewards)).not.to.be.reverted;
    let tx = pool.connect(Alice).initialize(totalRewards, rewardsDuration, maxReportSpan);
    await expect(tx).to.changeTokenBalances(rewardToken, [Alice, await pool.getAddress()], [-totalRewards, totalRewards]);
    await expect(tx).to.emit(pool, 'Initialized').withArgs(totalRewards, rewardsDuration, maxReportSpan);

    // Not started until first registered worker
    expect(await pool.started()).to.equal(false);
    expect(await pool.periodFinish()).to.equal(0);

    // Can't settle pool before finish
    await expect(pool.connect(Alice).settlePool(Alice.address)).to.be.revertedWith('not finished yet');

    // Worker can't exit or submit work report before register
    await expect(pool.connect(Alice).exit()).to.be.revertedWith('unregistered worker');
    await expect(pool.connect(Alice).submitWorkReport(true)).to.be.revertedWith('unregistered worker');

    // Day 1: Alice regisers as a worker
    await time.increase(ONE_DAY_IN_SECS);
    await expect(pool.connect(Alice).register())
      .to.emit(pool, 'WorkerRegistered').withArgs(Alice.address);
    expect(await pool.started()).to.equal(true);
    expectBigNumberEquals(await pool.periodFinish(), BigInt(await time.latest()) + rewardsDuration);
    expect(await pool.totalWorkers()).to.equal(1);

    // Total rewards: 0.1 $RWD per day.
    let totalRewardsPerHour = ethers.parseUnits('0.1', await rewardToken.decimals()) / 24n;
    await time.increase(ONE_HOUR_IN_SECS - 1n);
    await expect(pool.connect(Alice).submitWorkReport(true))
      .to.emit(pool, 'WorkReportSubmitted').withArgs(Alice.address, true, true);
    expectBigNumberEquals(await pool.earned(Alice.address), totalRewardsPerHour);
    tx = pool.connect(Alice).claimRewards();
    await expect(tx).to.emit(pool, 'RewardsClaimed').withArgs(Alice.address, anyValue);

    // After 1.5 hour, Alice submit another valid report. And earns nothing
    await time.increase(ONE_HOUR_IN_SECS * 3n / 2n);
    await expect(pool.connect(Alice).submitWorkReport(true))
      .to.emit(pool, 'WorkReportSubmitted').withArgs(Alice.address, true, false);
    expectBigNumberEquals(await pool.earned(Alice.address), 0n);
    expectBigNumberEquals(await pool.undistributedRewards(), totalRewardsPerHour * 3n / 2n);

    // After 0.5 hour, Alice submit another valid report, should earn 0.5 hour rewards
    let lastTime = BigInt(await time.increase(ONE_HOUR_IN_SECS / 2n - 1n));
    await expect(pool.connect(Alice).submitWorkReport(true))
      .to.emit(pool, 'WorkReportSubmitted').withArgs(Alice.address, true, true);
    expectBigNumberEquals(await pool.earned(Alice.address), totalRewardsPerHour / 2n);

    // Bob joins the pool
    await expect(pool.connect(Bob).register())
      .to.emit(pool, 'WorkerRegistered').withArgs(Bob.address);
    expect(await pool.totalWorkers()).to.equal(2);

    // 0.5 hour later, Alice submit a false report, which should be ignored
    await time.increaseTo(lastTime + ONE_HOUR_IN_SECS / 2n);
    await expect(pool.connect(Alice).submitWorkReport(false))
      .to.emit(pool, 'WorkReportSubmitted').withArgs(Alice.address, false, true);
    
    // 0.5 hour later, both Alice and Bob submit valid reports
    await time.increaseTo(lastTime + ONE_HOUR_IN_SECS - 1n);
    lastTime = BigInt(await time.latest());
    await expect(pool.connect(Alice).submitWorkReport(true))
      .to.emit(pool, 'WorkReportSubmitted').withArgs(Alice.address, true, true);
    await expect(pool.connect(Bob).submitWorkReport(true))
      .to.emit(pool, 'WorkReportSubmitted').withArgs(Bob.address, true, true);
    expectBigNumberEquals(await pool.earned(Alice.address), totalRewardsPerHour / 2n + totalRewardsPerHour / 2n);
    expectBigNumberEquals(await pool.earned(Bob.address), totalRewardsPerHour / 2n);

    // Caro joins the pool
    await expect(pool.connect(Caro).register())
      .to.emit(pool, 'WorkerRegistered').withArgs(Caro.address);
    expect(await pool.totalWorkers()).to.equal(3);
    
    // 1 hour later (within), Alice, Bob, Call, all submit valid reports. They share the rewards
    await time.increaseTo(lastTime + ONE_HOUR_IN_SECS - 1n);
    await expect(pool.connect(Alice).submitWorkReport(true))
      .to.emit(pool, 'WorkReportSubmitted').withArgs(Alice.address, true, true);
    await expect(pool.connect(Bob).submitWorkReport(true))
      .to.emit(pool, 'WorkReportSubmitted').withArgs(Bob.address, true, true);
    await expect(pool.connect(Caro).submitWorkReport(true))
      .to.emit(pool, 'WorkReportSubmitted').withArgs(Caro.address, true, true);
    expectBigNumberEquals(await pool.earned(Alice.address), totalRewardsPerHour / 2n + totalRewardsPerHour / 2n + totalRewardsPerHour / 3n);
    expectBigNumberEquals(await pool.earned(Bob.address), totalRewardsPerHour / 2n + totalRewardsPerHour / 3n);
    expectBigNumberEquals(await pool.earned(Caro.address), totalRewardsPerHour / 3n);

    // Alice exits the pool, and still could claim his rewards
    await expect(pool.connect(Alice).exit())
      .to.emit(pool, 'WorkerExited').withArgs(Alice.address);
    expect(await pool.totalWorkers()).to.equal(2);
    let aliceExactRewards = await pool.earned(Alice.address);
    // console.log(aliceExactRewards);
    expectBigNumberEquals(aliceExactRewards, totalRewardsPerHour / 2n + totalRewardsPerHour / 2n + totalRewardsPerHour / 3n);
    tx = pool.connect(Alice).claimRewards();
    await expect(tx).to.emit(pool, 'RewardsClaimed').withArgs(Alice.address, aliceExactRewards);
    await expect(tx).to.changeTokenBalances(rewardToken, [Alice, await pool.getAddress()], [aliceExactRewards, -aliceExactRewards]);
    expect(await pool.earned(Alice.address)).to.equal(0);

    // 1 hour later (within), Bob and Caro submit valid reports, and share the rewards
    expectBigNumberEquals(await pool.earned(Bob.address), totalRewardsPerHour / 2n + totalRewardsPerHour / 3n);
    expectBigNumberEquals(await pool.earned(Caro.address), totalRewardsPerHour / 3n);
    await time.increaseTo(lastTime + ONE_HOUR_IN_SECS * 2n - 1n);
    await expect(pool.connect(Alice).submitWorkReport(true)).to.be.revertedWith('unregistered worker');
    await expect(pool.connect(Bob).submitWorkReport(true))
      .to.emit(pool, 'WorkReportSubmitted').withArgs(Bob.address, true, true);
    await expect(pool.connect(Caro).submitWorkReport(true))
      .to.emit(pool, 'WorkReportSubmitted').withArgs(Caro.address, true, true);
    expectBigNumberEquals(await pool.earned(Bob.address), totalRewardsPerHour / 2n + totalRewardsPerHour / 3n + totalRewardsPerHour / 2n);
    expectBigNumberEquals(await pool.earned(Caro.address), totalRewardsPerHour / 3n + totalRewardsPerHour / 2n);

    // 1 hour later (within), Bob leaves the pool, and Caro submits a valid report.
    let undistributedRewards = await pool.undistributedRewards();
    await time.increaseTo(lastTime + ONE_HOUR_IN_SECS * 3n - 1n);
    await expect(pool.connect(Bob).exit())
      .to.emit(pool, 'WorkerExited').withArgs(Bob.address);
    await expect(pool.connect(Caro).submitWorkReport(true))
      .to.emit(pool, 'WorkReportSubmitted').withArgs(Caro.address, true, true);
    expectBigNumberEquals(await pool.earned(Caro.address), totalRewardsPerHour / 3n + totalRewardsPerHour / 2n + totalRewardsPerHour / 2n);
    expectBigNumberEquals(await pool.undistributedRewards(), undistributedRewards + totalRewardsPerHour / 2n);

    let exactRewardsOfCaro = await pool.earned(Caro.address);
    undistributedRewards = await pool.undistributedRewards();
  
    // Fast forward to the end
    await time.increaseTo(await pool.periodFinish() + 1n);
    // Caro's total rewards should remain unchanged, since she does not submit valid report
    expectBigNumberEquals(await pool.earned(Caro.address), exactRewardsOfCaro);

    // Now if somebody settles the pool, he get the undistributed rewards
    tx = pool.connect(Dave).settlePool(Dave.address);
    await expect(tx).to.emit(pool, 'PoolSettled').withArgs(Dave.address, undistributedRewards);
    await expect(tx).to.changeTokenBalances(rewardToken, [await pool.getAddress(), Dave], [-undistributedRewards, undistributedRewards]);

    // Now Caro exits the pool, her un-settled rewards should be tracked as undistributed rewards
    await expect(pool.connect(Caro).exit())
      .to.emit(pool, 'WorkerExited').withArgs(Caro.address);
    tx = pool.connect(Caro).claimRewards();
    await expect(tx).to.emit(pool, 'RewardsClaimed').withArgs(Caro.address, exactRewardsOfCaro);
    await expect(tx).to.changeTokenBalances(rewardToken, [await pool.getAddress(), Caro], [-exactRewardsOfCaro, exactRewardsOfCaro]);

    let poolBalance = await rewardToken.balanceOf(await pool.getAddress());
    // console.log(poolBalance);
    undistributedRewards = await pool.undistributedRewards();
    // console.log(undistributedRewards);
    expectBigNumberEquals(poolBalance, undistributedRewards);

    tx = pool.connect(Dave).settlePool(Dave.address);
    await expect(tx).to.emit(pool, 'PoolSettled').withArgs(Dave.address, undistributedRewards);
    await expect(tx).to.changeTokenBalances(rewardToken, [await pool.getAddress(), Dave], [-undistributedRewards, undistributedRewards]);

  });

});