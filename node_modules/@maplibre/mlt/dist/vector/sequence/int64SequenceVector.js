import { SequenceVector } from "./sequenceVector";
export class Int64SequenceVector extends SequenceVector {
    constructor(name, baseValue, delta, size) {
        super(name, BigInt64Array.of(baseValue), delta, size);
    }
    getValueFromBuffer(index) {
        return this.dataBuffer[0] + BigInt(index) * this.delta;
    }
}
//# sourceMappingURL=int64SequenceVector.js.map