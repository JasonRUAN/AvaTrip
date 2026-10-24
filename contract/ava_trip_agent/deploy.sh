#!/usr/bin/env bash
set -euo pipefail

# forge 必须在 foundry 项目根目录运行：.env 读取、../../deployments 相对路径都依赖它
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

REQUIRED=(
    PRIVATE_KEY
    ORCHESTRATOR_ADDRESS
    FLIGHT_AGENT_ADDRESS
    HOTEL_AGENT_ADDRESS
    ATTRACTION_AGENT_ADDRESS
    DINING_AGENT_ADDRESS
)

missing=()
for var in "${REQUIRED[@]}"; do
    if [ -z "${!var:-}" ] && ! grep -qE "^${var}=" .env 2>/dev/null; then
        missing+=("$var")
    fi
done

if [ ${#missing[@]} -ne 0 ]; then
    echo "缺少环境变量: ${missing[*]}（写到 .env 或先 export）" >&2
    exit 1
fi

CHAIN="${1:-}"
if [ -z "$CHAIN" ]; then
    echo "用法: $0 <rpc别名>    例如 sepolia、monad 或 fuji" >&2
    echo "支持的别名见 foundry.toml [rpc_endpoints]：sepolia / monad / fuji" >&2
    echo "已部署过的链默认拒绝重部署，确需重部署用 FORCE=1（或 FORCE_<别名大写>=1）。" >&2
    exit 1
fi

if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

# 每条链一份部署快照 deployments/<别名>.json，逻辑与 Deploy.s.sol 的 _deploymentPath() 对应。
# tokenURI 按链隔离：orchestrator 用 /api/vouchers/c/<chainId>/<tokenId>/metadata 出元数据，
# 各链默认走本地 orchestrator（:3010），线上用 VOUCHER_BASE_URI_<别名大写> 覆盖。
# 新增链：在 foundry.toml [rpc_endpoints] 加别名，再在这里补一个分支。
CHAIN_ID=""
NATIVE=""
FAUCET_URL=""
case "$CHAIN" in
    sepolia)
        CHAIN_ID="11155111"
        export VOUCHER_BASE_URI="${VOUCHER_BASE_URI_SEPOLIA:-http://127.0.0.1:3010/api/vouchers/c/${CHAIN_ID}/}"
        NATIVE="ETH"
        FAUCET_URL="https://cloud.google.com/application/web3/faucet/ethereum/sepolia"
        ;;
    monad)
        CHAIN_ID="10143"
        export VOUCHER_BASE_URI="${VOUCHER_BASE_URI_MONAD:-http://localhost:3010/api/vouchers/c/${CHAIN_ID}/}"
        NATIVE="MON"
        FAUCET_URL="https://faucet.monad.xyz"
        ;;
    fuji)
        CHAIN_ID="43113"
        export VOUCHER_BASE_URI="${VOUCHER_BASE_URI_FUJI:-http://127.0.0.1:3010/api/vouchers/c/${CHAIN_ID}/}"
        NATIVE="AVAX"
        FAUCET_URL="https://core.app/tools/testnet-faucet"
        ;;
    *)
        echo "警告: ${CHAIN} 不在已知链列表，跳过 baseURI / 余额预置。" >&2
        echo "      需自行 export VOUCHER_BASE_URI 与 DEPLOYMENT_OUT，否则 Deploy.s.sol 会 revert。" >&2
        ;;
esac

# 已上线的链不允许误重部署：覆盖会换掉全部合约地址并同步进 frontend/ 与 agents/，
# 已登记的服务商和已签发凭证会全部失联。对任何链一视同仁，确需重部署时显式加 FORCE。
DEPLOY_JSON="$SCRIPT_DIR/../../deployments/${CHAIN}.json"
CHAIN_UPPER="$(printf '%s' "$CHAIN" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"
if [ -f "$DEPLOY_JSON" ] && grep -q '"deployed"[[:space:]]*:[[:space:]]*true' "$DEPLOY_JSON" \
    && [ "${FORCE:-0}" != "1" ] && [ "$(printenv "FORCE_${CHAIN_UPPER}" || true)" != "1" ]; then
    echo "${CHAIN}（chainId ${CHAIN_ID:-未知}）已部署过：${DEPLOY_JSON} 中 deployed=true，拒绝重新 broadcast。" >&2
    echo "覆盖会换掉全部合约地址，已登记服务商和已签发凭证将失联。" >&2
    echo "确需重部署：FORCE=1 $0 ${CHAIN}" >&2
    exit 1
fi

if [ -n "$NATIVE" ]; then
    if [ -x "${HOME}/.foundry/bin/cast" ]; then
        CAST="${HOME}/.foundry/bin/cast"
    else
        CAST="$(command -v cast)"
    fi
    DEPLOYER="$("$CAST" wallet address --private-key "$PRIVATE_KEY")"
    BALANCE="$("$CAST" balance "$DEPLOYER" --rpc-url "$CHAIN")"
    if [ "$BALANCE" = "0" ]; then
        echo "部署者 ${DEPLOYER} 在 ${CHAIN} 上 ${NATIVE} 余额为 0，跳过广播。" >&2
        echo "请先到 ${FAUCET_URL} 领取 ${NATIVE}，再执行 ./deploy.sh ${CHAIN}" >&2
        exit 0
    fi
fi

# Sepolia 自 2026-10-06 起是 Glamsterdam：calldata 64 gas/byte，新建合约另计 state gas。
# 本机 forge 1.7.1 仍按 Osaka 估价，默认 130% 会让创建交易在链上 out-of-gas。
# 800% 后的 gas limit 仍低于 16,777,216，不会撞上单笔交易上限。
GAS_ARGS=()
if [ "$CHAIN" = "sepolia" ]; then
    GAS_ARGS=(--gas-estimate-multiplier 800)
fi

forge script script/Deploy.s.sol:Deploy --rpc-url "$CHAIN" --broadcast "${GAS_ARGS[@]}"

mkdir -p "$SCRIPT_DIR/../../frontend/deployments" "$SCRIPT_DIR/../../agents/deployments"
/bin/cp -f "$SCRIPT_DIR/../../deployments/"*.json "$SCRIPT_DIR/../../frontend/deployments/"
/bin/cp -f "$SCRIPT_DIR/../../deployments/"*.json "$SCRIPT_DIR/../../agents/deployments/"
