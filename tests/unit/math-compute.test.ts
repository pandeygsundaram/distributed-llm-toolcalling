import { describe, it, expect } from "vitest";
import { mathCompute } from "../../src/tools/math-compute.js";

describe("mathCompute — basic arithmetic", () => {
  it("add", () => expect(mathCompute({ operation: "add", a: 3, b: 4 })).toBe("7"));
  it("subtract", () => expect(mathCompute({ operation: "subtract", a: 10, b: 4 })).toBe("6"));
  it("multiply", () => expect(mathCompute({ operation: "multiply", a: 6, b: 7 })).toBe("42"));
  it("divide", () => expect(mathCompute({ operation: "divide", a: 10, b: 4 })).toBe("2.5"));
  it("divide by zero throws", () => expect(() => mathCompute({ operation: "divide", a: 5, b: 0 })).toThrow("division by zero"));
  it("modulo", () => expect(mathCompute({ operation: "modulo", a: 17, b: 5 })).toBe("2"));
  it("modulo by zero throws", () => expect(() => mathCompute({ operation: "modulo", a: 5, b: 0 })).toThrow("modulo by zero"));
});

describe("mathCompute — exponentiation and roots", () => {
  it("power: 2^10", () => expect(mathCompute({ operation: "power", a: 2, b: 10 })).toBe("1024"));
  it("power: 3^3", () => expect(mathCompute({ operation: "power", a: 3, b: 3 })).toBe("27"));
  it("sqrt: 144", () => expect(mathCompute({ operation: "sqrt", a: 144 })).toBe("12"));
  it("sqrt: 2", () => expect(Number(mathCompute({ operation: "sqrt", a: 2 }))).toBeCloseTo(1.4142, 4));
});

describe("mathCompute — factorial", () => {
  it("0! = 1", () => expect(mathCompute({ operation: "factorial", a: 0 })).toBe("1"));
  it("1! = 1", () => expect(mathCompute({ operation: "factorial", a: 1 })).toBe("1"));
  it("5! = 120", () => expect(mathCompute({ operation: "factorial", a: 5 })).toBe("120"));
  it("10! = 3628800", () => expect(mathCompute({ operation: "factorial", a: 10 })).toBe("3628800"));
  it("20! is exact bigint", () => expect(mathCompute({ operation: "factorial", a: 20 })).toBe("2432902008176640000"));
  it("negative throws", () => expect(() => mathCompute({ operation: "factorial", a: -1 })).toThrow());
  it("over 1000 throws", () => expect(() => mathCompute({ operation: "factorial", a: 1001 })).toThrow());
});

describe("mathCompute — fibonacci", () => {
  it("fib(0) = 0", () => expect(mathCompute({ operation: "fibonacci", a: 0 })).toBe("0"));
  it("fib(1) = 1", () => expect(mathCompute({ operation: "fibonacci", a: 1 })).toBe("1"));
  it("fib(10) = 55", () => expect(mathCompute({ operation: "fibonacci", a: 10 })).toBe("55"));
  it("fib(20) = 6765", () => expect(mathCompute({ operation: "fibonacci", a: 20 })).toBe("6765"));
  it("fib(50) is exact", () => expect(mathCompute({ operation: "fibonacci", a: 50 })).toBe("12586269025"));
});

describe("mathCompute — is_prime", () => {
  it("1 is not prime", () => expect(mathCompute({ operation: "is_prime", a: 1 })).toBe("false"));
  it("2 is prime", () => expect(mathCompute({ operation: "is_prime", a: 2 })).toBe("true"));
  it("17 is prime", () => expect(mathCompute({ operation: "is_prime", a: 17 })).toBe("true"));
  it("100 is not prime", () => expect(mathCompute({ operation: "is_prime", a: 100 })).toBe("false"));
  it("7919 is prime", () => expect(mathCompute({ operation: "is_prime", a: 7919 })).toBe("true"));
});

describe("mathCompute — gcd", () => {
  it("gcd(12, 8) = 4", () => expect(mathCompute({ operation: "gcd", a: 12, b: 8 })).toBe("4"));
  it("gcd(100, 75) = 25", () => expect(mathCompute({ operation: "gcd", a: 100, b: 75 })).toBe("25"));
  it("gcd(17, 5) = 1 (coprime)", () => expect(mathCompute({ operation: "gcd", a: 17, b: 5 })).toBe("1"));
  it("gcd with negative inputs", () => expect(mathCompute({ operation: "gcd", a: -12, b: 8 })).toBe("4"));
});
