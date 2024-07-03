// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.18;

// import "hardhat/console.sol";

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract WorkingPool is Ownable, ReentrancyGuard {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    /* ========== STATE VARIABLES ========== */

    EnumerableSet.AddressSet internal workers;
    mapping(address => uint256) public totalRewardsSettledAndUnclaimedForWorkers;

    IERC20 public rewardsToken;
    uint256 public totalRewards;
    uint256 public totalRewardsPerSec;
    uint256 public undistributedRewards;

    uint256 public perSecPerWorkerTotalRewardsSettled;
    mapping(address => uint256) public perSecTotalRewardsSettledForWorkers;

    uint256 public rewardsDuration;
    uint256 public maxReportSpan;
    uint256 public periodFinish;
    uint256 public lastSettleTime;

    mapping(address => uint256) public lastWorkReportTime;

    bool public initialized;
    bool public started;

    /* ========== CONSTRUCTOR ========== */

    constructor(address _rewardsToken) Ownable() {
        require(_rewardsToken != address(0), "zero address detected");
        rewardsToken = IERC20(_rewardsToken);
    }

    function initialize(uint256 _totalRewards, uint256 _rewardsDuration, uint256 _maxReportSpan) external nonReentrant onlyOwner {
        require(!initialized, "already initialized");

        require(_totalRewards > 0, "too few rewards");
        require(_rewardsDuration > 0, "too short rewards duration");
        require(_maxReportSpan > 0, "too short report span");
        totalRewards = _totalRewards;
        rewardsDuration = _rewardsDuration;
        maxReportSpan = _maxReportSpan;
        
        rewardsToken.safeTransferFrom(msg.sender, address(this), totalRewards);

        initialized = true;
        emit Initialized(totalRewards, rewardsDuration, maxReportSpan);
    }

    /* ========== VIEWS ========== */

    function totalWorkers() public view returns (uint256) {
        return workers.length();
    }

    function settleTimeApplicable() public view returns (uint256) {
        return Math.min(block.timestamp, periodFinish);
    }

    function perSecPerWorkerTotalRewardsTillNow() public view returns (uint256) {
        if (totalWorkers() == 0) {
            return perSecPerWorkerTotalRewardsSettled;
        }
        return
            perSecPerWorkerTotalRewardsSettled.add(
                settleTimeApplicable().sub(lastSettleTime).mul(totalRewardsPerSec).mul(1e18).div(totalWorkers()).div(1e18)
            );
    }

    function perSecTotalRewardsPendingSettleForWorker(address worker) public view returns (uint256) {
        return perSecPerWorkerTotalRewardsTillNow().sub(perSecTotalRewardsSettledForWorkers[worker]);
    }

    function earned(address worker) public view returns (uint256) {
        return totalRewardsSettledAndUnclaimedForWorkers[worker];
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function register() external nonReentrant onlyInitialized {
        require(!workers.contains(msg.sender), "already registered");
        _doSettleRewards(msg.sender, true, false);

        bool firstWorker = workers.length() == 0;
        if (!started && firstWorker) {
            started = true;
            totalRewardsPerSec = totalRewards.div(rewardsDuration);
            lastSettleTime = block.timestamp;
            periodFinish = block.timestamp.add(rewardsDuration);
        }

        workers.add(msg.sender);
        lastWorkReportTime[msg.sender] = block.timestamp;

        emit WorkerRegistered(msg.sender);
    }

    function exit() external nonReentrant onlyInitialized {
        require(workers.contains(msg.sender), "unregistered worker");
        _doSettleRewards(address(0), false, false);

        workers.remove(msg.sender);
        emit WorkerExited(msg.sender);
    }

    function claimRewards() external nonReentrant onlyInitialized {
        _doSettleRewards(msg.sender, false, false);

        uint256 rewards = totalRewardsSettledAndUnclaimedForWorkers[msg.sender];
        if (rewards > 0) {
            totalRewardsSettledAndUnclaimedForWorkers[msg.sender] = 0;
            rewardsToken.safeTransfer(msg.sender, rewards);
            emit RewardsClaimed(msg.sender, rewards);
        }
    }

    function submitWorkReport(bool mockValid) external nonReentrant onlyInitialized {
        require(workers.contains(msg.sender), "unregistered worker");
        bool inReportWindow = block.timestamp.sub(lastWorkReportTime[msg.sender]) <= maxReportSpan;
        if (!mockValid) {
            emit WorkReportSubmitted(msg.sender, false, inReportWindow);
            return;
        }

        if (!inReportWindow) {
            undistributedRewards += perSecTotalRewardsPendingSettleForWorker(msg.sender);
        }
        _doSettleRewards(msg.sender, false, inReportWindow);

        

        lastWorkReportTime[msg.sender] = block.timestamp;
        emit WorkReportSubmitted(msg.sender, mockValid, inReportWindow);
    }

    function settlePool(address toAddress) external nonReentrant onlyInitialized {
        require(toAddress != address(0), "zero address detected");
        require(periodFinish > 0 && block.timestamp > periodFinish, "not finished yet");
        if (undistributedRewards > 0) {
            rewardsToken.safeTransfer(toAddress, undistributedRewards);
            undistributedRewards = 0;
        }
        emit PoolSettled(toAddress, undistributedRewards);
    }
    
    /* ========== MODIFIERS ========== */

    modifier onlyInitialized() {
        require(initialized, "not initialized");
        _;
    }

    function _doSettleRewards(address worker, bool newWorker, bool settleNewRewards) internal {
        perSecPerWorkerTotalRewardsSettled = perSecPerWorkerTotalRewardsTillNow();
        lastSettleTime = settleTimeApplicable();
        if (worker != address(0)) {
            if (newWorker) {
                totalRewardsSettledAndUnclaimedForWorkers[worker] = 0;
            }
            else if (settleNewRewards) {
                // Pending Settle & Pending Claim ===> Settled & Pending Claim
                totalRewardsSettledAndUnclaimedForWorkers[worker] += perSecTotalRewardsPendingSettleForWorker(worker);
            }
            perSecTotalRewardsSettledForWorkers[worker] = perSecPerWorkerTotalRewardsSettled;
        }
    }

    /* ========== EVENTS ========== */
    event Initialized(uint256 totalRewards, uint256 rewardsDuration, uint256 maxReportSpan);
    event WorkerRegistered(address indexed worker);
    event WorkerExited(address indexed worker);
    event RewardsClaimed(address indexed user, uint256 rewards);
    event WorkReportSubmitted(address indexed worker, bool valid, bool inReportWindow);
    event PoolSettled(address indexed toAddress, uint256 rewards);
}
