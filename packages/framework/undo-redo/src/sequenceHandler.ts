/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IJSONSegment,
    ISegment,
    matchProperties,
    MergeTreeDeltaOperationType,
    MergeTreeDeltaType,
    PropertySet,
    ReferenceType,
    TrackingGroup,
} from "@microsoft/fluid-merge-tree";
import { SequenceDeltaEvent, SharedSegmentSequence } from "@microsoft/fluid-sequence";
import { IRevertable, UndoRedoStackManager } from "./undoRedoStackManager";

/**
 * A shared segment sequence undo redo handler that will add all local sequences changes to the provided
 * undo redo stack manager
 */
export class SharedSegmentSequenceUndoRedoHandler {

    // eslint-disable-next-line max-len
    private readonly sequences = new Map<SharedSegmentSequence<ISegment>, SharedSegmentSequenceRevertable | undefined>();

    constructor(private readonly stackManager: UndoRedoStackManager) {
        this.stackManager.on("changePushed", () => this.sequences.clear());
    }

    public attachSequence<T extends ISegment>(sequence: SharedSegmentSequence<T>) {
        sequence.on("sequenceDelta", this.sequenceDeltaHandler);
    }

    public detachSequence<T extends ISegment>(sequence: SharedSegmentSequence<T>) {
        sequence.removeListener("sequenceDelta", this.sequenceDeltaHandler);
    }

    private readonly sequenceDeltaHandler = (event: SequenceDeltaEvent, target: SharedSegmentSequence<ISegment>) => {
        if (event.isLocal) {
            let revertable = this.sequences.get(target);
            if (revertable === undefined) {
                revertable = new SharedSegmentSequenceRevertable(target);
                this.stackManager.pushToCurrentOperation(revertable);
                this.sequences.set(target, revertable);
            }
            revertable.add(event);
        }
    };
}

interface ITrackedSharedSegmentSequenceRevertable {
    trackingGroup: TrackingGroup;
    propertyDelta: PropertySet;
    operation: MergeTreeDeltaOperationType;
}

/**
 * Tracks a change on a shared segment sequence and allows reverting it
 */
export class SharedSegmentSequenceRevertable implements IRevertable {

    private readonly tracking: ITrackedSharedSegmentSequenceRevertable[];

    constructor(
        public readonly sequence: SharedSegmentSequence<ISegment>,
    ) {
        this.tracking = [];
    }

    public add(event: SequenceDeltaEvent) {
        if (event.ranges.length > 0) {
            let current = this.tracking.length > 0 ? this.tracking[this.tracking.length - 1] : undefined;
            for (const range of event.ranges) {
                if (current !== undefined
                    && current.operation === event.deltaOperation
                    && matchProperties(current.propertyDelta, range.propertyDeltas)) {
                    current.trackingGroup.link(range.segment);
                } else {
                    const tg = new TrackingGroup();
                    tg.link(range.segment);
                    current = {
                        trackingGroup: tg,
                        propertyDelta: range.propertyDeltas,
                        operation: event.deltaOperation as MergeTreeDeltaOperationType,
                    };
                    this.tracking.push(current);
                }
            }
        }
    }

    public revert() {
        while (this.tracking.length > 0) {
            const tracked = this.tracking.pop();
            if (tracked !== undefined) {
                while (tracked.trackingGroup.size > 0) {
                    const sg = tracked.trackingGroup.segments[0];
                    sg.trackingCollection.unlink(tracked.trackingGroup);
                    /* eslint-disable @typescript-eslint/indent */
                    switch (tracked.operation) {
                        case MergeTreeDeltaType.INSERT:
                            if (sg.removedSeq === undefined) {
                                const start = this.sequence.getPosition(sg);
                                this.sequence.removeRange(start, start + sg.cachedLength);
                            }
                            break;

                        case MergeTreeDeltaType.REMOVE:
                            const insertSegment = this.sequence.segmentFromSpec(sg.toJSONObject() as IJSONSegment);
                            this.sequence.insertAtReferencePosition(
                                this.sequence.createPositionReference(sg, 0, ReferenceType.Transient),
                                insertSegment);
                            sg.trackingCollection.trackingGroups.forEach((tg) => {
                                tg.link(insertSegment);
                                tg.unlink(sg);
                            });
                            break;

                        case MergeTreeDeltaType.ANNOTATE:
                            if (sg.removedSeq === undefined) {
                                const start = this.sequence.getPosition(sg);
                                this.sequence.annotateRange(
                                    start,
                                    start + sg.cachedLength,
                                    tracked.propertyDelta,
                                    undefined);
                            }
                        default:
                            throw new Error("operationt type not revertable");
                    }
                    /* eslint-enable @typescript-eslint/indent */
                }
            }
        }
    }

    public disgard() {
        while (this.tracking.length > 0) {
            const tracked = this.tracking.pop();
            if (tracked !== undefined) {
                while (tracked.trackingGroup.size > 0) {
                    tracked.trackingGroup.unlink(tracked.trackingGroup.segments[0]);
                }
            }
        }
    }
}
