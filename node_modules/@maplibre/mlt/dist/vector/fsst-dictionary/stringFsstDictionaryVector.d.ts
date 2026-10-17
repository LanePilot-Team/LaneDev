import { VariableSizeVector } from "../variableSizeVector";
import type BitVector from "../flat/bitVector";
export declare class StringFsstDictionaryVector extends VariableSizeVector<Uint8Array, string> {
    private readonly indexBuffer;
    private readonly symbolOffsetBuffer;
    private readonly symbolTableBuffer;
    private symbolLengthBuffer;
    private decodedDictionary;
    constructor(name: string, indexBuffer: Uint32Array, offsetBuffer: Uint32Array, dictionaryBuffer: Uint8Array, symbolOffsetBuffer: Uint32Array, symbolTableBuffer: Uint8Array, nullabilityBuffer: BitVector);
    protected getValueFromBuffer(index: number): string;
    private offsetToLengthBuffer;
}
