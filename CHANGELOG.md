# Changelog

## 1.2.2
- **Critical fix**: the llm/stream waterfall listener must return an AsyncIterable synchronously. It was declared sync, so it returned a Promise; the upstream dsh-session-checkpoint-policy does yield* next(), which threw TypeError: yield* (intermediate value) is not async iterable and failed the whole turn before any chunk arrived. The listener is now synchronous and awaits downstream inside the generator. Added a regression test (26/26).
## 1.1.0
- Web UI seat beside the composer model picker (provider multi-select, save/clear/enable-disable, recent events)
- Host routes /api/model-failover/{status,set,clear,toggle}

## 1.0.0
- Provider-pool failover on the official agent/request-error recovery point

