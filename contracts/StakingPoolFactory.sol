// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import './StakingPool.sol';

contract StakingPoolFactory is Ownable, ReentrancyGuard {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // immutables
    address public rewardsToken;

    // the staking tokens for which the rewards contract has been deployed
    address[] public stakingTokens;

    // info about rewards for a particular staking token
    struct StakingRewardsInfo {
        address poolAddress;
        uint totalRewardsAmount;
    }

    // rewards info by staking token
    mapping(address => StakingRewardsInfo) public stakingRewardsInfoByStakingToken;

    EnumerableSet.AddressSet private _rewardersSet;

    constructor(
        address _rewardsToken
    ) Ownable() {
        rewardsToken = _rewardsToken;
        addRewarder(_msgSender());
    }

    function getStakingPoolAddress(address stakingToken) public virtual view returns (address) {
        StakingRewardsInfo storage info = stakingRewardsInfoByStakingToken[stakingToken];
        require(info.poolAddress != address(0), 'StakingPoolFactory::getStakingPoolAddress: not deployed');
        return info.poolAddress;
    }

    /// @dev No guarantees are made on the ordering
    function getRewarders() public view returns (address[] memory) {
        return _rewardersSet.values();
    }

    ///// permissioned functions

    // deploy a staking reward contract for the staking token, and store the reward amount
    // the reward will be distributed to the staking reward contract no sooner than the genesis
    function deploy(address stakingToken) public onlyOwner {
        StakingRewardsInfo storage info = stakingRewardsInfoByStakingToken[stakingToken];
        require(info.poolAddress == address(0), 'StakingPoolFactory::deploy: already deployed');

        info.poolAddress = address(new StakingPool(/*_rewardsDistribution=*/ address(this), rewardsToken, stakingToken));
        info.totalRewardsAmount = 0;
        stakingTokens.push(stakingToken);
        emit StakingPoolDeployed(info.poolAddress, stakingToken);
    }

    ///// permissionless functions


    function addRewards(address stakingToken, uint256 rewardsAmount, uint256 roundDurationInDays) public onlyRewarder {
        StakingRewardsInfo storage info = stakingRewardsInfoByStakingToken[stakingToken];
        require(info.poolAddress != address(0), 'StakingPoolFactory::addRewards: not deployed');
        require(roundDurationInDays > 0, 'StakingPoolFactory::addRewards: duration too short');

        if (rewardsAmount > 0) {
            info.totalRewardsAmount = info.totalRewardsAmount.add(rewardsAmount);

            IERC20(rewardsToken).safeTransferFrom(msg.sender, info.poolAddress, rewardsAmount);
            StakingPool(info.poolAddress).notifyRewardAmount(rewardsAmount, roundDurationInDays);
        }
    }

    function addRewarder(address rewarder) public nonReentrant onlyOwner {
        require(rewarder != address(0), "Zero address detected");
        require(!_rewardersSet.contains(rewarder), "Already added");

        _rewardersSet.add(rewarder);
        emit RewarderAdded(rewarder);
    }

    function removeRewarder(address rewarder) public nonReentrant onlyOwner {
        require(_rewardersSet.contains(rewarder), "Not a rewarder");
        require(_rewardersSet.remove(rewarder), "Failed to remove rewarder");
        emit RewarderRemoved(rewarder);
    }

    modifier onlyRewarder() {
        require(_rewardersSet.contains(_msgSender()), "Not a rewarder");
        _;
    }

    event StakingPoolDeployed(address indexed poolAddress, address indexed stakingToken);
    event RewarderAdded(address indexed rewarder);
    event RewarderRemoved(address indexed rewarder);
}