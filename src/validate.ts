/**
 * 参数校验。所有整数均以十进制字符串输入，用 BigInt 解析，
 * 绝不先经过 Number，避免大整数精度丢失。
 */

/** 参数（m/a/c/seed）允许的最大十进制位数。 */
export const MAX_PARAM_DIGITS = 200;
/** 步号 / 步数允许的最大十进制位数（远超 Number.MAX_SAFE_INTEGER 的 16 位）。 */
export const MAX_STEP_DIGITS = 30;
/** 单次批量生成数量上限。 */
export const MAX_BATCH = 1000;

export type ErrorCode =
  | 'INVALID_INTEGER'
  | 'OUT_OF_RANGE'
  | 'M_TOO_SMALL'
  | 'TOO_MANY_DIGITS'
  | 'BATCH_TOO_LARGE'
  | 'MISSING_FIELD'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'BAD_REQUEST';

export class ValidationError extends Error {
  readonly code: ErrorCode;
  readonly field?: string;
  constructor(code: ErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.field = field;
  }
}

const INT_RE = /^(0|[1-9][0-9]*)$/;

/** 解析非负十进制整数字符串为 BigInt，拒绝空格、负号、科学计数法等。 */
export function parseNonNegBigint(
  raw: unknown,
  field: string,
  maxDigits: number,
): bigint {
  if (typeof raw !== 'string') {
    throw new ValidationError(
      'MISSING_FIELD',
      `字段 ${field} 必须是十进制整数字符串`,
      field,
    );
  }
  const s = raw.trim();
  if (!INT_RE.test(s)) {
    throw new ValidationError(
      'INVALID_INTEGER',
      `字段 ${field} 不是合法的非负十进制整数（收到：${raw.slice(0, 32)}）`,
      field,
    );
  }
  if (s.length > maxDigits) {
    throw new ValidationError(
      'TOO_MANY_DIGITS',
      `字段 ${field} 位数 ${s.length} 超过上限 ${maxDigits} 位`,
      field,
    );
  }
  return BigInt(s);
}

export interface LcgParams {
  m: bigint;
  a: bigint;
  c: bigint;
  seed: bigint;
}

export interface LcgParamsInput {
  m: unknown;
  a: unknown;
  c: unknown;
  seed: unknown;
}

/** 校验 m>=2 且 a、c、seed 均落在 [0, m-1]。 */
export function validateParams(input: LcgParamsInput): LcgParams {
  const fields = ['m', 'a', 'c', 'seed'] as const;
  for (const f of fields) {
    if (input[f] === undefined || input[f] === null) {
      throw new ValidationError('MISSING_FIELD', `缺少字段 ${f}`, f);
    }
  }
  const m = parseNonNegBigint(input.m, 'm', MAX_PARAM_DIGITS);
  const a = parseNonNegBigint(input.a, 'a', MAX_PARAM_DIGITS);
  const c = parseNonNegBigint(input.c, 'c', MAX_PARAM_DIGITS);
  const seed = parseNonNegBigint(input.seed, 'seed', MAX_PARAM_DIGITS);

  if (m < 2n) {
    throw new ValidationError('M_TOO_SMALL', '模数 m 必须至少为 2', 'm');
  }
  for (const [name, v] of [
    ['a', a],
    ['c', c],
    ['seed', seed],
  ] as const) {
    if (v >= m) {
      throw new ValidationError(
        'OUT_OF_RANGE',
        `参数 ${name} 必须在 [0, m-1] 范围内，收到 ${v.toString()}，m=${m.toString()}`,
        name,
      );
    }
  }
  return { m, a, c, seed };
}

/** 解析非负步数/步号（支持超过 Number 安全整数范围）。 */
export function parseStep(raw: unknown, field = 'k'): bigint {
  const k = parseNonNegBigint(raw, field, MAX_STEP_DIGITS);
  // parseNonNegBigint 已保证非负
  return k;
}

/** 解析正整数（如子序列步长 d）。 */
export function parsePositive(raw: unknown, field: string): bigint {
  const v = parseNonNegBigint(raw, field, MAX_STEP_DIGITS);
  if (v < 1n) {
    throw new ValidationError(
      'OUT_OF_RANGE',
      `字段 ${field} 必须为正整数`,
      field,
    );
  }
  return v;
}

/** 解析批量生成数量 n（必须是 0..MAX_BATCH 的安全整数）。 */
export function parseCount(raw: unknown, field = 'count'): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    throw new ValidationError(
      'INVALID_INTEGER',
      `字段 ${field} 必须是安全整数（0..${MAX_BATCH}）`,
      field,
    );
  }
  if (raw < 0) {
    throw new ValidationError(
      'OUT_OF_RANGE',
      `字段 ${field} 不能为负`,
      field,
    );
  }
  if (raw > MAX_BATCH) {
    throw new ValidationError(
      'BATCH_TOO_LARGE',
      `字段 ${field}=${raw} 超过单次上限 ${MAX_BATCH}`,
      field,
    );
  }
 return raw;
}

/** 解析乐观锁版本号（正整数，从 1 开始）。 */
export function parseVersion(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
    throw new ValidationError(
      'INVALID_INTEGER',
      'expectedVersion 必须为不小于 1 的安全整数',
      'expectedVersion',
    );
  }
  return raw;
}
