# DiffusionGemma demo

Standalone Bun demo for testing `universal-llm-client` against DiffusionGemma
served by vLLM's OpenAI-compatible API.

## Run the backend

From `packages/universal-llm-client`:

```bash
docker compose -f src/demos/diffusion-gemma/docker-compose.yml up -d
```

The compose file runs a `diffusiongemma` container on `localhost:8000`, mounts a
demo-local Hugging Face cache at `src/demos/diffusion-gemma/.cache/huggingface`,
and bind-mounts `start-vllm.sh` as the container entrypoint.

If you already have an older hand-created `diffusiongemma` container, remove it
before switching to the demo compose file:

```bash
docker rm -f diffusiongemma
```

Optional overrides:

```bash
cp src/demos/diffusion-gemma/.env.example src/demos/diffusion-gemma/.env
docker compose --env-file src/demos/diffusion-gemma/.env -f src/demos/diffusion-gemma/docker-compose.yml up -d
```

Useful knobs are `VLLM_IMAGE`, `GPU_MEM_UTIL`, `MAX_MODEL_LEN`,
`DIFFUSION_ENTROPY`, `ENFORCE_EAGER`, and `VLLM_NO_USAGE_STATS`.

## Run the demo UI

```bash
bun run src/demos/diffusion-gemma/server.ts
```

- Harness: <http://localhost:3333/>
- Canvas: <http://localhost:3333/canvas>
- vLLM API: <http://localhost:8000/v1/models>

## Notes

- The prior BentoKit setup did not use a `docker-compose.yml`; it was a direct
  Docker container using a repo-root `scripts/diffusiongemma-start.sh` bind
  mount. This demo now carries its own compose file and startup script.
- The default image is `vllm/vllm-openai:gemma`, the vLLM image line that
  includes DiffusionGemma support. Set `VLLM_IMAGE` if you need to test another
  local or registry image.
- The first startup can take several minutes while vLLM loads and compiles the
  model. Poll `docker logs -f diffusiongemma` or `/api/health` from the demo UI.
- The `/api/engine-config` endpoint writes `diffusion-env.sh` into the mounted
  Hugging Face cache and restarts the `diffusiongemma` container.
- `VLLM_NO_USAGE_STATS=1` is enabled by default because this vLLM image can hit
  a non-fatal `py-cpuinfo` `JSONDecodeError` in its background usage-reporting
  thread under WSL during startup/reload.
