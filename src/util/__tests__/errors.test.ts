import { describe, it, expect } from "vitest";
import { getErrorMessage } from "../errors.js";

describe("getErrorMessage", () => {
  it("returns .message for an Error instance", () => {
    expect(getErrorMessage(new Error("something broke"))).toBe("something broke");
  });

  it("returns .message for an Error subclass", () => {
    expect(getErrorMessage(new TypeError("bad type"))).toBe("bad type");
  });

  it("returns the string as-is for a string value", () => {
    expect(getErrorMessage("raw string error")).toBe("raw string error");
  });

  it("returns string representation for a number", () => {
    expect(getErrorMessage(42)).toBe("42");
  });

  it("returns 'null' for null", () => {
    expect(getErrorMessage(null)).toBe("null");
  });

  it("returns 'undefined' for undefined", () => {
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("returns string representation for a plain object", () => {
    expect(getErrorMessage({ foo: "bar" })).toBe("[object Object]");
  });

  it("returns string representation for an object with toString()", () => {
    const obj = { toString: () => "custom string" };
    expect(getErrorMessage(obj)).toBe("custom string");
  });
});
