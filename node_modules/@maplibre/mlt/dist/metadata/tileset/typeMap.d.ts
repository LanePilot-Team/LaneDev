import { type Column } from "./tilesetMetadata";
/**
 * The type code is a single varint32 that encodes:
 * - Physical or logical type
 * - Nullable flag
 * - Whether the column has a name (typeCode >= 10)
 * - Whether the column has children (typeCode == 30 for STRUCT)
 * - For ID types: whether it uses long (64-bit) IDs
 */
/**
 * Decodes a type code into a Column structure.
 *
 * ID type codes (0..3):
 * - Bit 0: nullable
 * - Bit 1: longID (0/1 -> uint32 IDs, 2/3 -> uint64 IDs)
 *
 * ID columns are kept as logical types so they remain distinguishable
 * from feature properties that may also be named "id".
 */
export declare function decodeColumnType(typeCode: number): Column | null;
/**
 * Returns true if this type code requires a name to be stored.
 * ID (0-3) and GEOMETRY (4) columns have implicit names.
 * All other types (>= 10) require explicit names.
 */
export declare function columnTypeHasName(typeCode: number): boolean;
/**
 * Returns true if this type code has child fields.
 * Only STRUCT (typeCode 30) has children.
 */
export declare function columnTypeHasChildren(typeCode: number): boolean;
/**
 * Determines if a stream count needs to be read for this column.
 * Mirrors the logic in cpp/include/mlt/metadata/type_map.hpp lines 85-122
 */
export declare function hasStreamCount(column: Column): boolean;
export declare function isLogicalIdColumn(column: Column): boolean;
export declare function isGeometryColumn(column: Column): boolean;
