import { SequenceVector } from "./sequenceVector";
export class Int32SequenceVector extends SequenceVector {
    constructor(name, baseValue, delta, size) {
        super(name, Int32Array.of(baseValue), delta, size);
    }
    getValueFromBuffer(index) {
        return this.dataBuffer[0] + index * this.delta;
    }
}
//# sourceMappingURL=int32SequenceVector.js.map