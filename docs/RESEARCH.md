# Launch research - 2026-10-07

Research was intentionally short and execution-oriented.

## OpenAI plan access

OpenAI now documents Sign in with ChatGPT for open-source and local apps. Eligible users can authorize an OSS client to make eligible Responses API requests using applicable ChatGPT plan usage without supplying an API key.

Official references:

- https://developers.openai.com/siwc/quickstart
- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites
- https://openai.com/policies/sign-in-with-chatgpt-terms/

The documented direct OSS flow requires explicit user consent, protected token storage, store:false, stream:true, supported Responses API fields, and documented scopes. It must not use private ChatGPT backend endpoints or become a generic subscription-to-API proxy.

## Why v0 uses Codex CLI first

The official Codex CLI already supports ChatGPT sign-in and non-interactive codex exec. KORA Reach therefore uses Codex only as the optional frontier escalation runtime in v0. KORA owns routing, local work, verification, safety gates, and execution statistics.

Official references:

- https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- https://github.com/openai/codex

This gets a useful agent public without rebuilding authentication during the launch window.

## License note

The current openai/sign-in-with-chatgpt-devkit repository uses the Sign-in with ChatGPT DevKit Noncommercial License v1.0. KORA Reach does not copy or bundle that DevKit code. A future direct Sign in with ChatGPT implementation should use the public protocol documentation or separately permitted components.

## OSS reviewed

- OpenAI Codex CLI - selected for frontier coding escalation.
- Aider - strong coding option, but a second coding runtime is unnecessary for v0.
- OpenHands - capable but broader than this CLI needs.
- Open Interpreter - broader local execution surface than the first three demos require.

Decision: ship a thin KORA control loop, not another general agent framework.
