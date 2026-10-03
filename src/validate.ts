import { ApiError } from "./errors";

export const MAX_DIGITS = 100; // 十进制位数上限
export const MAX_BATCH = 10000; // 单次批量生成上限
export const MAX_EXPORT = 100000;

const DEC_RE = /^(0|[1-9][0-9]*)$/;

export function parseDec(value: unknown, name: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ApiError("INVALID_PARAM", `${name} 必须是非负整数十进制字符串`);
    }
    return BigInt(value);
  }
  if (typeof value !== "string" || !DEC_RE.test(value)) {
    throw new ApiError("INVALID_PARAM", `${name} 必须是非负整数十进制字符串`);
  }
  if (value.length > MAX_DIGITS) {
    throw new ApiError("LIMIT_EXCEEDED", `${name} 超过 ${MAX_DIGITS} 位上限`);
  }
  return BigInt(value);
}

export function parseCount(value: unknown, name: string, max: number): number {
  const v = parseDec(value, name);
  if (v > BigInt(max)) {
    throw new ApiError("LIMIT_EXCEEDED", `${name} 超过上限 ${max}`);
  }
  return Number(v);
}

export function checkRange(v: bigint, m: bigint, name: string): void {
  if (v < 0n || v >= m) {
    throw new ApiError("INVALID_PARAM", `${name} 必须在 [0, m-1] 范围内`);
  }
}

export function checkModulus(m: bigint): void {
  if (m < 2n) {
    throw new ApiError("INVALID_PARAM", "模数 m 必须 >= 2");
  }
}
