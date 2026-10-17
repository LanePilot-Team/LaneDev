import { SequenceVector } from "./sequenceVector";
export declare class Int64SequenceVector extends SequenceVector<BigInt64Array, bigint> {
    constructor(name: string, baseValue: bigint, delta: bigint, size: number);
    protected getValueFromBuffer(index: number): bigint;
}
