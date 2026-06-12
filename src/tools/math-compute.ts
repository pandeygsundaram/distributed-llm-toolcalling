export type MathOperation =
  | "add" | "subtract" | "multiply" | "divide" | "modulo"
  | "power" | "sqrt" | "factorial" | "fibonacci" | "is_prime" | "gcd";

export interface MathComputeInput {
  operation: MathOperation;
  a?: number;
  b?: number;
}

export function mathCompute(input: MathComputeInput): string {
  const a = Number(input.a ?? 0);
  const b = Number(input.b ?? 0);

  switch (input.operation) {
    case "add":      return String(a + b);
    case "subtract": return String(a - b);
    case "multiply": return String(a * b);
    case "divide":
      if (b === 0) throw new Error("division by zero");
      return String(a / b);
    case "modulo":
      if (b === 0) throw new Error("modulo by zero");
      return String(a % b);
    case "power":    return String(Math.pow(a, b));
    case "sqrt":     return String(Math.sqrt(a));
    case "factorial": {
      const n = Math.floor(a);
      if (n < 0 || n > 1000) throw new Error("factorial: n must be 0–1000");
      let f = 1n;
      for (let i = 2n; i <= BigInt(n); i++) f *= i;
      return f.toString();
    }
    case "fibonacci": {
      const n = Math.floor(a);
      if (n < 0 || n > 10_000) throw new Error("fibonacci: n must be 0–10000");
      let x = 0n, y = 1n;
      for (let i = 0; i < n; i++) { const t = x + y; x = y; y = t; }
      return x.toString();
    }
    case "is_prime": {
      const n = Math.floor(a);
      if (n < 2) return "false";
      for (let i = 2; i <= Math.sqrt(n); i++) {
        if (n % i === 0) return "false";
      }
      return "true";
    }
    case "gcd": {
      let x = Math.abs(Math.floor(a)), y = Math.abs(Math.floor(b));
      while (y) { const t = y; y = x % y; x = t; }
      return String(x);
    }
    default:
      throw new Error(`Unknown operation: ${(input as MathComputeInput).operation}`);
  }
}
