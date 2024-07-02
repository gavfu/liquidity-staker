import _ from 'lodash';
import { ethers } from 'hardhat';
import { expect } from 'chai';
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { ONE_DAY_IN_SECS, deployContractsFixture, expandTo18Decimals, expectBigNumberEquals } from './utils';
import { FlashStakingPool__factory } from '../typechain';

const { provider } = ethers;

describe('Flash Farm', () => {

  it('Basic scenario works', async () => {

    const { rewardToken, stakingToken, Alice, Bob, Caro } = await loadFixture(deployContractsFixture);

    const FlashStakingPool = await ethers.getContractFactory('FlashStakingPool');
    const FlashStakingPoolContract = await FlashStakingPool.deploy(await rewardToken.getAddress(), await stakingToken.getAddress());
    const flashFarm = FlashStakingPool__factory.connect(await FlashStakingPoolContract.getAddress(), provider);

    const genesisTime = BigInt(await time.latest()) + ONE_DAY_IN_SECS;
    await expect(stakingToken.connect(Alice).mint(Bob.address, expandTo18Decimals(10_000))).not.to.be.reverted;
    await expect(stakingToken.connect(Alice).mint(Caro.address, expandTo18Decimals(10_000))).not.to.be.reverted;

    // Bob stakes 800 $LSD, and Caro stakes 200 $LSD
    let bobStakeAmount = expandTo18Decimals(800);
    let caroStakeAmount = expandTo18Decimals(200);
    await expect(stakingToken.connect(Bob).approve(await flashFarm.getAddress(), bobStakeAmount)).not.to.be.reverted;
    await expect(flashFarm.connect(Bob).stake(bobStakeAmount)).not.to.be.reverted;
    await expect(stakingToken.connect(Caro).approve(await flashFarm.getAddress(), caroStakeAmount)).not.to.be.reverted;
    await expect(flashFarm.connect(Caro).stake(caroStakeAmount)).not.to.be.reverted;
    expect(await flashFarm.totalSupply()).to.equal(bobStakeAmount + caroStakeAmount);

    // Fast-forward to reward start time, and deposit 10_000 $LSD as reward
    await time.increaseTo(genesisTime);
    const totalReward = expandTo18Decimals(10_000);
    await expect(rewardToken.connect(Alice).mint(Alice.address, totalReward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await flashFarm.getAddress(), totalReward)).not.to.be.reverted;
    await expect(flashFarm.connect(Alice).addRewards(totalReward))
      .to.emit(flashFarm, 'RewardAdded').withArgs(totalReward);

    // Fast-forward to Day 2. Reward perioid finish
    await time.increaseTo(genesisTime + ONE_DAY_IN_SECS * 2n);

    // Bob should get 4/5 rewards, and Caro should get 1/5 rewards
    expectBigNumberEquals(totalReward * 4n / 5n, await flashFarm.earned(Bob.address));
    expectBigNumberEquals(totalReward / 5n, await flashFarm.earned(Caro.address));

    // Bob claim rewards
    // console.log('Bob earned', ethers.utils.formatUnits((await flashFarm.earned(Bob.address)).toString(), 18));
    await expect(flashFarm.connect(Bob).getReward())
      .to.emit(flashFarm, 'RewardPaid').withArgs(Bob.address, anyValue);
    
    // Fast-forward to Day 5, and start another round of reward
    await time.increaseTo(genesisTime + ONE_DAY_IN_SECS * 5n);
    const round2Reward = expandTo18Decimals(20_000);
    await expect(rewardToken.connect(Alice).mint(Alice.address, round2Reward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await flashFarm.getAddress(), round2Reward)).not.to.be.reverted;
    await expect(flashFarm.connect(Alice).addRewards(round2Reward))
      .to.emit(flashFarm, 'RewardAdded').withArgs(round2Reward);

    // Fast-forward to Day 7. Bob should get 4/5 rewards, and Caro should get 1/5 rewards
    await time.increaseTo(genesisTime + ONE_DAY_IN_SECS * 7n);
    expectBigNumberEquals(round2Reward * 4n / 5n, await flashFarm.earned(Bob.address));
    expectBigNumberEquals(totalReward / 5n + (round2Reward / 5n), await flashFarm.earned(Caro.address));

    // Bob withdraw 600 stakes. Going forward, Bob and Caro should get 1/2 rewards respectively
    await expect(flashFarm.connect(Bob).withdraw(expandTo18Decimals(600))).not.to.be.reverted;

    // Fast-forward to Day 9. Add new reward
    await time.increaseTo(genesisTime + ONE_DAY_IN_SECS * 9n);
    const round3Reward = expandTo18Decimals(30_000);
    await expect(rewardToken.connect(Alice).mint(Alice.address, round3Reward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await flashFarm.getAddress(), round3Reward)).not.to.be.reverted;
    await expect(flashFarm.connect(Alice).addRewards(round3Reward)).not.to.be.reverted;

    // Fast-forward to Day 10. Add new reward
    await time.increaseTo(genesisTime + ONE_DAY_IN_SECS * 10n);
    const round4Reward = expandTo18Decimals(33_333);
    await expect(rewardToken.connect(Alice).mint(Alice.address, round4Reward)).not.to.be.reverted;
    await expect(rewardToken.connect(Alice).approve(await flashFarm.getAddress(), round4Reward)).not.to.be.reverted;
    await expect(flashFarm.connect(Alice).addRewards(round4Reward)).not.to.be.reverted;

    // Check Bob and Caro's rewards
    expectBigNumberEquals(round2Reward * 4n / 5n + round3Reward / 2n + round4Reward / 2n, await flashFarm.earned(Bob.address));
    expectBigNumberEquals(totalReward / 5n + round2Reward / 5n + round3Reward /2n + round4Reward / 2n, await flashFarm.earned(Caro.address));

  });

});