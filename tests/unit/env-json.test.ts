import { afterEach, describe, expect, test } from "bun:test";
import { optionalEnv, requiredEnv } from "../../lib/env.js";
import { errorMessage, isJsonObject, responseJson } from "../../lib/json.js";

const originalValue = process.env.TEST_ENV_VALUE;

afterEach(() => {
  if (originalValue === undefined) delete process.env.TEST_ENV_VALUE;
  else process.env.TEST_ENV_VALUE = originalValue;
});

describe("environment helpers", () => {
  test("trims optional and required values", () => {
    process.env.TEST_ENV_VALUE = "  configured  ";
    expect(optionalEnv("TEST_ENV_VALUE")).toBe("configured");
    expect(requiredEnv("TEST_ENV_VALUE")).toBe("configured");
  });

  test("rejects missing required values", () => {
    delete process.env.TEST_ENV_VALUE;
    expect(() => requiredEnv("TEST_ENV_VALUE")).toThrow("Missing required environment variable");
  });
});

describe("JSON helpers", () => {
  test("distinguishes objects from arrays and null", () => {
    expect(isJsonObject({ value: 1 })).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });

  test("parses valid response JSON and rejects invalid JSON", async () => {
    await expect(responseJson(Response.json({ ok: true }))).resolves.toEqual({ ok: true });
    await expect(responseJson(new Response("not-json"))).rejects.toThrow("Expected JSON response");
  });

  test("does not assume caught values are Error instances", () => {
    expect(errorMessage(new Error("failure"))).toBe("failure");
    expect(errorMessage("failure")).toBe("Unknown error");
  });
});
