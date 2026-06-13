#!/usr/bin/env bash
set -euo pipefail

echo "=== Upgrading transformers ==="
pip install --upgrade transformers

echo "=== Installing WSL2 UVA compatibility patch ==="
cat > /usr/local/lib/python3.12/dist-packages/wsl2_uva_patch.py <<'PYEOF'
"""
WSL2 UVA compatibility patch for vLLM.

UVA lets the GPU directly access pinned CPU memory. WSL2 does not support this
path reliably, so this patch uses explicit CPU/GPU copies instead.
"""
import warnings

import numpy as np
import torch

warnings.warn("WSL2 UVA patch active: using explicit CPU/GPU copies instead of UVA")

import vllm.v1.worker.gpu.buffer_utils as bu


class PatchedUvaBuffer:
    def __init__(self, size, dtype):
        self.cpu = torch.zeros(size, dtype=dtype, device="cpu", pin_memory=False)
        self.np = self.cpu.numpy()
        self._gpu = torch.zeros(size, dtype=dtype, device="cuda")
        self.uva = self._gpu

    def sync_to_gpu(self):
        self._gpu.copy_(self.cpu, non_blocking=True)


class PatchedUvaBufferPool:
    def __init__(self, size, dtype, max_concurrency=None):
        if max_concurrency is None:
            max_concurrency = bu._DEFAULT_MAX_CONCURRENCY
        self.size = size
        self.dtype = dtype
        self.max_concurrency = max_concurrency
        self._uva_bufs = [PatchedUvaBuffer(size, dtype) for _ in range(max_concurrency)]
        self._curr = 0

    def copy_to_uva(self, x):
        self._curr = (self._curr + 1) % self.max_concurrency
        buf = self._uva_bufs[self._curr]
        dst = buf.cpu if isinstance(x, torch.Tensor) else buf.np
        n = len(x)
        dst[:n] = x
        buf.sync_to_gpu()
        return buf.uva[:n]


import vllm.utils.platform_utils as pu
pu.is_uva_available = lambda: True

import vllm.utils.torch_utils as tu
tu.get_accelerator_view_from_cpu_tensor = lambda cpu_tensor: cpu_tensor.cuda()

bu.UvaBuffer = PatchedUvaBuffer
bu.UvaBufferPool = PatchedUvaBufferPool

print("[WSL2 UVA Patch] Applied successfully - using explicit CPU/GPU copies")
PYEOF

echo "import wsl2_uva_patch" > /usr/local/lib/python3.12/dist-packages/wsl2_uva_patch.pth

if [ -f /root/.cache/huggingface/diffusion-env.sh ]; then
  # This file is written by the demo server's /api/engine-config endpoint.
  . /root/.cache/huggingface/diffusion-env.sh
fi

MODEL_NAME="${MODEL_NAME:-RedHatAI/diffusiongemma-26B-A4B-it-NVFP4}"
GPU_MEM_UTIL="${GPU_MEM_UTIL:-0.28}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-32768}"
MAX_NUM_SEQS="${MAX_NUM_SEQS:-1}"
DIFFUSION_ENTROPY="${DIFFUSION_ENTROPY:-0.1}"
ENFORCE_EAGER="${ENFORCE_EAGER:-0}"
export VLLM_NO_USAGE_STATS="${VLLM_NO_USAGE_STATS:-1}"

echo "=== Engine config: MODEL_NAME=${MODEL_NAME} DIFFUSION_ENTROPY=${DIFFUSION_ENTROPY} GPU_MEM_UTIL=${GPU_MEM_UTIL} MAX_MODEL_LEN=${MAX_MODEL_LEN} MAX_NUM_SEQS=${MAX_NUM_SEQS} ENFORCE_EAGER=${ENFORCE_EAGER} VLLM_NO_USAGE_STATS=${VLLM_NO_USAGE_STATS} ==="

EAGER_FLAG=""
if [ "${ENFORCE_EAGER}" = "1" ]; then
  EAGER_FLAG="--enforce-eager"
fi

VLLM_USE_V2_MODEL_RUNNER=1 vllm serve "${MODEL_NAME}" \
  --trust-remote-code \
  --attention-backend TRITON_ATTN \
  --max-num-seqs "${MAX_NUM_SEQS}" \
  ${EAGER_FLAG} \
  --gpu-memory-utilization "${GPU_MEM_UTIL}" \
  --max-model-len "${MAX_MODEL_LEN}" \
  --hf-overrides "{\"diffusion_sampler\": \"entropy_bound\", \"diffusion_entropy_bound\": ${DIFFUSION_ENTROPY}}" \
  --default-chat-template-kwargs '{"enable_thinking": true}'
