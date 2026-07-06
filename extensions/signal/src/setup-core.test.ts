// Signal setup-core tests cover narrow setup adapter behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { signalSetupAdapter } from "./setup-core.js";

describe("signalSetupAdapter", () => {
  it("rejects non-interactive setup without a Signal account", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {} as OpenClawConfig,
        accountId: "default",
        input: {
          httpUrl: "http://127.0.0.1:8080",
        },
      }),
    ).toBe("Signal requires --signal-number before setup can be saved.");
  });

  it("keeps a configured Signal account for non-interactive reconfiguration", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {
          channels: {
            signal: {
              accounts: {
                default: {
                  account: "+15555550123",
                },
              },
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        input: {
          httpUrl: "http://127.0.0.1:8080",
        },
      }),
    ).toBeNull();
  });
});
