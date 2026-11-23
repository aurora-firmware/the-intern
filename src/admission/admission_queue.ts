// Pure admission logic: which conversation runs may hold a worker thread.
// No I/O and no pi-durable; the caller stores the state and applies the grants.

export type AdmissionState = { active: string[]; waiting: string[] };

/** Moves waiting ids to the active list, head first, while worker threads are free. */
function grantWhileRoom(state: AdmissionState, capacity: number): { state: AdmissionState; granted: string[] } {
    const room = Math.max(0, capacity - state.active.length);
    const granted = state.waiting.slice(0, room);
    return {
        state: { active: [...state.active, ...granted], waiting: state.waiting.slice(granted.length) },
        granted,
    };
}

export function request(
    state: AdmissionState,
    id: string,
    capacity: number,
): { state: AdmissionState; granted: boolean } {
    if (state.active.includes(id)) return { state, granted: true };
    if (state.waiting.includes(id)) return { state, granted: false };
    // A newcomer never jumps the queue: it is granted only when nobody waits.
    if (state.active.length < capacity && state.waiting.length === 0) {
        return { state: { active: [...state.active, id], waiting: state.waiting }, granted: true };
    }
    return { state: { active: state.active, waiting: [...state.waiting, id] }, granted: false };
}

export function release(
    state: AdmissionState,
    id: string,
    capacity: number,
): { state: AdmissionState; granted: string[] } {
    const remaining = {
        active: state.active.filter((activeId) => activeId !== id),
        waiting: state.waiting.filter((waitingId) => waitingId !== id),
    };
    return grantWhileRoom(remaining, capacity);
}

export function restore(state: AdmissionState, capacity: number): { state: AdmissionState; granted: string[] } {
    // A lowered capacity sends the latest-granted runs back to the head of the queue.
    const keptCount = Math.max(0, capacity);
    const normalized = {
        active: state.active.slice(0, keptCount),
        waiting: [...state.active.slice(keptCount), ...state.waiting],
    };
    return grantWhileRoom(normalized, capacity);
}

export function positions(state: AdmissionState): { conversationId: string; position: number }[] {
    return state.waiting.map((conversationId, index) => ({ conversationId, position: index + 1 }));
}
