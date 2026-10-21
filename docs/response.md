# Response

VIGIL can take two actions in NEXORA through its security API:

| Playbook | NEXORA endpoint | Effect |
| --- | --- | --- |
| Revoke API key | `POST /api/v1/security-actions/revoke-api-key` `{api_key_id, reason}` | The key stops working immediately. Integrations using it fail until a new key is issued. Any further use is logged in NEXORA as `api_key.used_after_revoke` and raises VGL-008 in VIGIL |
| Disable user | `POST /api/v1/security-actions/disable-user` `{user_id, reason}` | The account is disabled. NEXORA refuses to disable the last active admin |

## Approval flow

1. **Propose.** Any signed-in user (analyst or admin) proposes an action from an incident. VIGIL suggests targets taken from the incident's events: NEXORA users and API keys involved. The proposal is recorded in the timeline and the audit log.
2. **Decide.** Only an **admin** can approve or reject, and both require a written reason (at least 5 characters). The admin role is checked on the server for every call. Four eyes: the person who proposed an action cannot approve it; another admin has to (they may still reject their own proposal).
3. **Execute.** On approval, VIGIL calls NEXORA with the **respond key** (`NEXORA_RESPONSE_API_KEY`, scope `security:respond`). This key is separate from the read key used for polling. The reason is sent to NEXORA together with the VIGIL incident id, and the response action id is used as the `Idempotency-Key`.
4. **Record.** The status (executed or failed), the request summary (method, URL, body, header *names* only) and the response summary (status code and body excerpt) go to the incident timeline, the response record and the audit log. The key itself is never stored.

There is **no automatic destructive response** anywhere in VIGIL. Rules only raise alerts.

## Simulated incidents

Incidents built from simulated events are labelled Simulated. Approving an action on them records it as executed, with the note "Simulated incident: no request was sent to NEXORA". No HTTP request is made.

## Failure modes

| Situation | Result |
| --- | --- |
| `NEXORA_URL` or the respond key is missing | The action is recorded as failed, with the reason |
| NEXORA refuses (for example, the last active admin, or a key revoking itself) | The action is recorded as failed, with NEXORA's error |
| The admin is rate limited (20 response decisions per hour) | The decision is refused |

## Verified

`tests/unit/pipeline.test.ts` covers:
- the simulated path makes no call
- the real path uses the right URL and key, and never stores the key
- a reason is required
- a decision cannot be made twice
- a missing configuration is recorded as a failure

On 2026-10-20 a live run against a local NEXORA confirmed the full loop. A drill key probing the security API raised VGL-009. Revoking it from the incident after admin approval made NEXORA return 401 "This API key was revoked." for that key.
