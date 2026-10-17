import { VariableSizeVector } from "../variableSizeVector";
import { decodeFsst } from "../../decoding/fsstDecoder";
import { decodeString } from "../../decoding/decodingUtils";
export class StringFsstDictionaryVector extends VariableSizeVector {
    constructor(name, indexBuffer, offsetBuffer, dictionaryBuffer, symbolOffsetBuffer, symbolTableBuffer, nullabilityBuffer) {
        super(name, offsetBuffer, dictionaryBuffer, nullabilityBuffer ?? indexBuffer.length);
        this.indexBuffer = indexBuffer;
        this.symbolOffsetBuffer = symbolOffsetBuffer;
        this.symbolTableBuffer = symbolTableBuffer;
    }
    getValueFromBuffer(index) {
        if (this.decodedDictionary == null) {
            if (this.symbolLengthBuffer == null) {
                // TODO: change FsstEncoder to take offsets instead of length to get rid of this conversion
                this.symbolLengthBuffer = this.offsetToLengthBuffer(this.symbolOffsetBuffer);
            }
            this.decodedDictionary = decodeFsst(this.symbolTableBuffer, this.symbolLengthBuffer, this.dataBuffer);
        }
        const offset = this.indexBuffer[index];
        const start = this.offsetBuffer[offset];
        const end = this.offsetBuffer[offset + 1];
        return decodeString(this.decodedDictionary, start, end);
    }
    // TODO: get rid of that conversion
    offsetToLengthBuffer(offsetBuffer) {
        const lengthBuffer = new Uint32Array(offsetBuffer.length - 1);
        let previousOffset = offsetBuffer[0];
        for (let i = 1; i < offsetBuffer.length; i++) {
            const offset = offsetBuffer[i];
            lengthBuffer[i - 1] = offset - previousOffset;
            previousOffset = offset;
        }
        return lengthBuffer;
    }
}
//# sourceMappingURL=stringFsstDictionaryVector.js.map