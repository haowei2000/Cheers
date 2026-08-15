import { describe, expect, it } from "vitest";
import { normalizeBase } from "./serverConfig";

describe("normalizeBase", () => {
  it("defaults hostnames to HTTPS and strips paths", () => {
    expect(normalizeBase("www.tocheers.com/path")).toBe("https://www.tocheers.com");
  });

  it("allows HTTP only for loopback development", () => {
    expect(normalizeBase("http://localhost:8000/path")).toBe("http://localhost:8000");
    expect(normalizeBase("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000");
    expect(normalizeBase("http://[::1]:8000")).toBe("http://[::1]:8000");
    expect(normalizeBase("http://192.168.1.20:8000")).toBeNull();
    expect(normalizeBase("http://example.com")).toBeNull();
  });
});
