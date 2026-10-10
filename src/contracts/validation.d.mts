export declare class ContractError extends Error {
  code: string;
  contract: string;
  field: string;
  constructor(code: string, contract: string, field: string, message: string);
}
export declare function canonicalSerialize(value: unknown): string;
export declare function canonicalHash(value: unknown): string;
