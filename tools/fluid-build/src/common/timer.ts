/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { logStatus } from "./logging";

export class Timer {
    private lastTime: number = Date.now();
    private totalTime: number = 0;

    constructor(private enabled: boolean) {

    }
    public time(msg?: string) {
        const currTime = Date.now();
        const diffTime = currTime - this.lastTime;
        this.lastTime = currTime;
        const diffTimeInSeconds = diffTime / 1000;
        if (this.enabled && msg) {
            if (diffTime > 100) {
                logStatus(`${msg} - ${diffTimeInSeconds.toFixed(3)}s`);
            } else {
                logStatus(`${msg} - ${diffTime}ms`);
            }
        }
        this.totalTime += diffTime;
        return diffTimeInSeconds;
    }

    public getTotalTime() {
        return this.totalTime;
    }
}