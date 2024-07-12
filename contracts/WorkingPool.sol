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
    mapping(address => uint256) internal _totalRewardsSettledAndUnclaimedForWorkersScaled;

    IERC20 public rewardsToken;
    uint256 public totalRewards;
    uint256 internal _totalRewardsPerSecScaled;
    uint256 internal _undistributedRewardsScaled;

    uint256 internal _perSecPerWorkerTotalRewardsSettledScaled;
    mapping(address => uint256) internal _perSecTotalRewardsSettledForWorkersScaled;

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

    function undistributedRewards() public view returns (uint256) {
        return _undistributedRewardsScaled.div(1e18);
    }

    function earned(address worker) public view returns (uint256) {
        return _totalRewardsSettledAndUnclaimedForWorkersScaled[worker].div(1e18);
    }

    function _settleTimeApplicable() internal view returns (uint256) {
        return Math.min(block.timestamp, periodFinish);
    }

    function _perSecPerWorkerTotalRewardsTillNowScaled() internal view returns (uint256) {
        if (totalWorkers() == 0) {
            return _perSecPerWorkerTotalRewardsSettledScaled;
        }
        return
            _perSecPerWorkerTotalRewardsSettledScaled.add(
                _settleTimeApplicable().sub(lastSettleTime).mul(_totalRewardsPerSecScaled).div(totalWorkers())
            );
    }

    function _perSecTotalRewardsPendingSettleForWorkerScaled(address worker) internal view returns (uint256) {
        return _perSecPerWorkerTotalRewardsTillNowScaled().sub(_perSecTotalRewardsSettledForWorkersScaled[worker]);
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function register() external nonReentrant onlyInitialized {
        require(!workers.contains(msg.sender), "already registered");
        _doSettleRewards(msg.sender, true, false);

        bool firstWorker = workers.length() == 0;
        if (!started && firstWorker) {
            started = true;
            _totalRewardsPerSecScaled = totalRewards.mul(1e18).div(rewardsDuration);
            lastSettleTime = block.timestamp;
            periodFinish = block.timestamp.add(rewardsDuration);
        }

        workers.add(msg.sender);
        lastWorkReportTime[msg.sender] = block.timestamp;

        emit WorkerRegistered(msg.sender);
    }

    function exit() external nonReentrant onlyInitialized {
        require(workers.contains(msg.sender), "unregistered worker");

        _undistributedRewardsScaled += _perSecTotalRewardsPendingSettleForWorkerScaled(msg.sender);
        _doSettleRewards(msg.sender, false, false);

        workers.remove(msg.sender);
        emit WorkerExited(msg.sender);
    }

    function claimRewards() external nonReentrant onlyInitialized {
        _doSettleRewards(msg.sender, false, false);

        uint256 rewards = _totalRewardsSettledAndUnclaimedForWorkersScaled[msg.sender];
        if (rewards > 0) {
            _totalRewardsSettledAndUnclaimedForWorkersScaled[msg.sender] = 0;
            rewardsToken.safeTransfer(msg.sender, rewards.div(1e18));
            emit RewardsClaimed(msg.sender, rewards.div(1e18));
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
            _undistributedRewardsScaled += _perSecTotalRewardsPendingSettleForWorkerScaled(msg.sender);
        }
        _doSettleRewards(msg.sender, false, inReportWindow);

        lastWorkReportTime[msg.sender] = block.timestamp;
        emit WorkReportSubmitted(msg.sender, mockValid, inReportWindow);
    }

    function recycle(address toAddress) external nonReentrant onlyInitialized onlyOwner {
        require(toAddress != address(0), "zero address detected");
        require(periodFinish > 0 && block.timestamp > periodFinish, "not finished yet");

        emit Recycled(toAddress, _undistributedRewardsScaled.div(1e18));
        if (_undistributedRewardsScaled > 0) {
            rewardsToken.safeTransfer(toAddress, _undistributedRewardsScaled.div(1e18));
            _undistributedRewardsScaled = 0;
        }
    }
    
    /* ========== MODIFIERS ========== */

    modifier onlyInitialized() {
        require(initialized, "not initialized");
        _;
    }

    function _doSettleRewards(address worker, bool newWorker, bool settleNewRewards) internal {
        require(worker != address(0), "zero address detected");

        _perSecPerWorkerTotalRewardsSettledScaled = _perSecPerWorkerTotalRewardsTillNowScaled();
        lastSettleTime = _settleTimeApplicable();
        if (newWorker) {
            _totalRewardsSettledAndUnclaimedForWorkersScaled[worker] = 0;
        }
        else if (settleNewRewards) {
            // Pending Settle & Pending Claim ===> Settled & Pending Claim
            _totalRewardsSettledAndUnclaimedForWorkersScaled[worker] += _perSecTotalRewardsPendingSettleForWorkerScaled(worker);
        }
        _perSecTotalRewardsSettledForWorkersScaled[worker] = _perSecPerWorkerTotalRewardsSettledScaled;
    }

    /* ========== EVENTS ========== */
    event Initialized(uint256 totalRewards, uint256 rewardsDuration, uint256 maxReportSpan);
    event WorkerRegistered(address indexed worker);
    event WorkerExited(address indexed worker);
    event RewardsClaimed(address indexed user, uint256 rewards);
    event WorkReportSubmitted(address indexed worker, bool valid, bool inReportWindow);
    event Recycled(address indexed toAddress, uint256 rewards);
}
