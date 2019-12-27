/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IComponentHandle } from "@microsoft/fluid-component-core-interfaces";
import { BaseSegment, createGroupOp, IJSONSegment, ISegment, PropertySet } from "@microsoft/fluid-merge-tree";
import {
    IChannelAttributes,
    IComponentRuntime,
    ISharedObjectServices,
    Jsonable,
    JsonablePrimitive,
} from "@microsoft/fluid-runtime-definitions";
import { ISharedObject, ISharedObjectFactory } from "@microsoft/fluid-shared-object-base";
import { pkgVersion } from "./packageVersion";
import { SharedSegmentSequence, SubSequence } from "./";

// An empty segment that occupies 'cachedLength' positions.  SparseMatrix uses PaddingSegment
// to "pad" a run of unoccupied cells.
export class PaddingSegment extends BaseSegment {
    public static readonly typeString = "PaddingSegment";
    public static is(segment: ISegment): segment is PaddingSegment {
        return segment.type === PaddingSegment.typeString;
    }
    public static fromJSONObject(spec: any) {
        if (spec && typeof spec === "object" && "pad" in spec) {
            const segment = new PaddingSegment(spec.pad);
            if (spec.props) {
                segment.addProperties(spec.props);
            }
            return segment;
        }
        return undefined;
    }
    public readonly type = PaddingSegment.typeString;

    constructor(size: number) {
        super();
        this.cachedLength = size;
    }

    public toJSONObject() {
        return { pad: this.cachedLength, props: this.properties };
    }

    public clone(start = 0, end?: number) {
        const b = new PaddingSegment(this.cachedLength);
        this.cloneInto(b);
        return b;
    }

    public canAppend(segment: ISegment) {
        return PaddingSegment.is(segment);
    }

    public toString() {
        return `[padding: ${this.cachedLength}]`;
    }

    public append(segment: ISegment) {
        if (!PaddingSegment.is(segment)) {
            throw new Error("can only append padding segment");
        }

        // Note: Must call 'appendLocalRefs' before modifying this segment's length as
        //       'this.cachedLength' is used to adjust the offsets of the local refs.
        this.appendLocalRefs(segment);

        this.cachedLength += segment.cachedLength;
    }

    // Returns true if entire run removed
    public removeRange(start: number, end: number) {
        this.cachedLength -= (end - start);
        return (this.cachedLength === 0);
    }

    protected createSplitSegmentAt(pos: number) {
        const leftLength = pos;
        const rightLength = this.cachedLength - pos;

        this.cachedLength = leftLength;
        return new PaddingSegment(rightLength);
    }
}

export type SparseMatrixItem = Jsonable<JsonablePrimitive | IComponentHandle>;
export class RunSegment extends SubSequence<SparseMatrixItem> {
    public static readonly typeString = "RunSegment";
    public static is(segment: ISegment): segment is RunSegment {
        return segment.type === RunSegment.typeString;
    }
    public static fromJSONObject(spec: any) {
        if (spec && typeof spec === "object" && "items" in spec) {
            const segment = new RunSegment(spec.items);
            if (spec.props) {
                segment.addProperties(spec.props);
            }
            return segment;
        }
        return undefined;
    }
    public readonly type = RunSegment.typeString;

    private tags: any[];

    constructor(public items: SparseMatrixItem[]) {
        super(items);
        this.tags = new Array(items.length).fill(undefined);
    }

    public clone(start = 0, end?: number) {
        const b = new RunSegment(this.items.slice(start, end));
        if (this.tags) {
            b.tags = this.tags.slice(start, end);
        }
        this.cloneInto(b);
        return b;
    }

    public append(segment: ISegment) {
        super.append(segment);

        const asRun = segment as RunSegment;
        if (asRun.tags) {
            if (this.tags) {
                this.tags.splice(this.items.length, 0, ...asRun.tags);
            }
        }

        return this;
    }

    // TODO: retain removed items for undo
    // returns true if entire run removed
    public removeRange(start: number, end: number) {
        this.tags.splice(start, end - start);
        return super.removeRange(start, end);
    }

    public getTag(pos: number) {
        return this.tags[pos];
    }

    public setTag(pos: number, tag: any) {
        this.tags[pos] = tag;
    }

    protected createSplitSegmentAt(pos: number) {
        if (pos > 0) {
            const remainingItems = this.items.slice(pos);
            this.items = this.items.slice(0, pos);
            this.cachedLength = this.items.length;

            const leafSegment = new RunSegment(remainingItems);
            leafSegment.tags = this.tags.slice(pos);
            this.tags.length = pos;

            return leafSegment;
        }
    }
}

export type MatrixSegment = RunSegment | PaddingSegment;

export const maxCol = 0x200000;         // X128 Excel maximum of 16,384 columns
export const maxCols = maxCol + 1;

export const maxRow = 0xFFFFFFFF;       // X4096 Excel maximum of 1,048,576 rows
export const maxRows = maxRow + 1;

export const maxCellPosition = maxCol * maxRow;

export const rowColToPosition = (row: number, col: number) => row * maxCols + col;

export function positionToRowCol(position: number) {
    const row = Math.floor(position / maxCols);
    const col = position - (row * maxCols);
    return { row, col };
}

export class SparseMatrix extends SharedSegmentSequence<MatrixSegment> {
    /**
     * Create a new sparse matrix
     *
     * @param runtime - component runtime the new sparse matrix belongs to
     * @param id - optional name of the sparse matrix
     * @returns newly create sparse matrix (but not attached yet)
     */
    public static create(runtime: IComponentRuntime, id?: string) {
        return runtime.createChannel(id, SparseMatrixFactory.Type) as SparseMatrix;
    }

    /**
     * Get a factory for SharedMap to register with the component.
     *
     * @returns a factory that creates and load SharedMap
     */
    public static getFactory(): ISharedObjectFactory {
        return new SparseMatrixFactory();
    }

    constructor(document: IComponentRuntime, public id: string) {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        super(document, id, SparseMatrixFactory.Attributes, SparseMatrixFactory.segmentFromSpec);
    }

    public get numRows() {
        return positionToRowCol(this.getLength()).row;
    }

    public setItems(
        row: number,
        col: number,
        values: SparseMatrixItem[],
        props?: PropertySet,
    ) {
        const start = rowColToPosition(row, col);
        const end = start + values.length;
        const segment = new RunSegment(values);
        if (props) {
            segment.addProperties(props);
        }

        this.replaceRange(start, end, segment);
    }

    public getItem(row: number, col: number) {
        const pos = rowColToPosition(row, col);
        const { segment, offset } =
            this.getContainingSegment(pos);
        if (RunSegment.is(segment)) {
            return segment.items[offset];
        } else if (PaddingSegment.is(segment)) {
            return undefined;
        }

        throw new Error(`Unrecognized Segment type`);
    }

    public getTag(row: number, col: number) {
        const { segment, offset } = this.getSegment(row, col);
        if (RunSegment.is(segment)) {
            return segment.getTag(offset);
        }
        return undefined;
    }

    public setTag(row: number, col: number, tag: any) {
        const { segment, offset } = this.getSegment(row, col);
        if (RunSegment.is(segment)) {
            segment.setTag(offset, tag);
        } else if (tag !== undefined) {
            throw new Error(`Must not attempt to set tags on '${segment.constructor.name}'.`);
        }
    }

    public insertRows(row: number, numRows: number) {
        const pos = rowColToPosition(row, 0);
        const size = maxCols * numRows;
        const segment = new PaddingSegment(size);

        const insertOp = this.client.insertSegmentLocal(pos, segment);
        if (insertOp) {
            this.submitSequenceMessage(insertOp);
        }
    }

    public removeRows(row: number, numRows: number) {
        const pos = rowColToPosition(row, 0);
        const size = maxCols * numRows;
        this.removeRange(pos, pos + size);
    }

    public insertCols(col: number, numCols: number) {
        this.moveAsPadding(maxCol - numCols, col, numCols);
    }

    public removeCols(col: number, numCols: number) {
        this.moveAsPadding(col, maxCol - numCols, numCols);
    }

    // For each row, moves 'numCols' items starting from 'srcCol' and inserts 'numCols' padding
    // at 'destCol'.  Used by insertCols and removeCols.
    private moveAsPadding(srcCol: number, destCol: number, numCols: number) {
        const removeColStart = srcCol;
        const removeColEnd = srcCol + numCols;
        const ops = [];

        for (let r = 0, rowStart = 0; r < this.numRows; r++ , rowStart += maxCols) {
            ops.push(this.client.removeRangeLocal(rowStart + removeColStart, rowStart + removeColEnd));
            const insertPos = rowStart + destCol;
            const segment = new PaddingSegment(numCols);
            ops.push(this.client.insertSegmentLocal(insertPos, segment));
        }

        this.submitSequenceMessage(createGroupOp(...ops));
    }

    private getSegment(row: number, col: number) {
        const pos = rowColToPosition(row, col);
        return this.getContainingSegment(pos);
    }
}

export class SparseMatrixFactory implements ISharedObjectFactory {
    public static Type = "https://graph.microsoft.com/types/mergeTree/sparse-matrix";

    public static Attributes: IChannelAttributes = {
        type: SparseMatrixFactory.Type,
        snapshotFormatVersion: "0.1",
        packageVersion: pkgVersion,
    };

    public static segmentFromSpec(spec: IJSONSegment): ISegment {
        const maybePadding = PaddingSegment.fromJSONObject(spec);
        if (maybePadding) {
            return maybePadding;
        }

        const maybeRun = RunSegment.fromJSONObject(spec);
        if (maybeRun) {
            return maybeRun;
        }

        throw new Error(`Unrecognized IJSONObject: '${JSON.stringify(spec)}'`);
    }

    public get type() {
        return SparseMatrixFactory.Type;
    }

    public get attributes() {
        return SparseMatrixFactory.Attributes;
    }

    public async load(
        document: IComponentRuntime,
        id: string,
        services: ISharedObjectServices,
        branchId: string,
    ): Promise<ISharedObject> {
        const sharedObject = new SparseMatrix(document, id);
        await sharedObject.load(branchId, services);
        return sharedObject;
    }

    public create(document: IComponentRuntime, id: string): ISharedObject {
        const sharedObject = new SparseMatrix(document, id);
        sharedObject.initializeLocal();
        return sharedObject;
    }
}
