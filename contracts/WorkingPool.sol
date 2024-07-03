// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.18;

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
    mapping(address => uint256) public workerRewardsPendingClaim;

    IERC20 public rewardsToken;
    uint256 public totalRewards;
    uint256 public totalRewardsPerSec;
    uint256 public undistributedRewards;

    uint256 public totalRewardsPerWorkerSettled;
    mapping(address => uint256) public rewardsPerWorkerSettled;

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

    function totalRewardsPerWorkerTillNow() public view returns (uint256) {
        if (totalWorkers() == 0) {
            return totalRewardsPerWorkerSettled;
        }
        return
            totalRewardsPerWorkerSettled.add(
                settleTimeApplicable().sub(lastSettleTime).mul(totalRewardsPerSec).mul(1e18).div(totalWorkers()).div(1e18)
            );
    }

    function workerRewardsPendingSettle(address worker) public view returns (uint256) {
        return totalRewardsPerWorkerTillNow().sub(rewardsPerWorkerSettled[worker]);
    }

    function earned(address worker) public view returns (uint256) {
        return workerRewardsPendingClaim[worker];
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function register() external nonReentrant onlyInitialized settleRewards(msg.sender) {
        require(!workers.contains(msg.sender), "already registered");

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

    function exit() external nonReentrant onlyInitialized settleRewards(address(0)) {
        require(workers.contains(msg.sender), "unregistered worker");
        workers.remove(msg.sender);

        emit WorkerExited(msg.sender);
    }

    function claimRewards() external nonReentrant onlyInitialized settleRewards(msg.sender) {
        require(workers.contains(msg.sender), "unregistered worker");
        uint256 rewards = workerRewardsPendingClaim[msg.sender];
        if (rewards > 0) {
            workerRewardsPendingClaim[msg.sender] = 0;
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

        totalRewardsPerWorkerSettled = totalRewardsPerWorkerTillNow();
        lastSettleTime = settleTimeApplicable();
        if (inReportWindow) {
            workerRewardsPendingClaim[msg.sender] += workerRewardsPendingSettle(msg.sender);
        } else {
            undistributedRewards += workerRewardsPendingSettle(msg.sender);
        }
        rewardsPerWorkerSettled[msg.sender] = totalRewardsPerWorkerSettled;

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

    modifier settleRewards(address worker) {
        totalRewardsPerWorkerSettled = totalRewardsPerWorkerTillNow();
        lastSettleTime = settleTimeApplicable();
        if (worker != address(0)) {
            // Pending Settle & Pending Claim ===> Settled & Pending Claim
            workerRewardsPendingClaim[worker] += workerRewardsPendingSettle(worker);
            rewardsPerWorkerSettled[worker] = totalRewardsPerWorkerSettled;
        }
        _;
    }

    /* ========== EVENTS ========== */
    event Initialized(uint256 totalRewards, uint256 rewardsDuration, uint256 maxReportSpan);
    event WorkerRegistered(address indexed worker);
    event WorkerExited(address indexed worker);
    event RewardsClaimed(address indexed user, uint256 rewards);
    event WorkReportSubmitted(address indexed worker, bool valid, bool inReportWindow);
    event PoolSettled(address indexed toAddress, uint256 rewards);
}
