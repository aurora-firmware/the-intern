/**
 * The-intern's admission extension (S-002 component 6, ADR-001): a pi-durable generation hook that waits for a worker
 * thread before every model request. Hooks can't write, so the hook only calls the host-side admission it is bound to.
 * The extension is built before the host opens, because the host installs it; the admission binds to it afterwards.
 */
import { defineExtension, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";

export const ADMISSION_EXTENSION_NAME = "intern.admission";

export type AcquireWorkerThread = (conversationId: string, signal: AbortSignal) => Promise<void>;

export type AdmissionGate = {
    /** Select this extension for every conversation (footgun 6). */
    extension: Extension;
    /** Connects the hook to the admission. Binding twice is a mistake. */
    bind(acquire: AcquireWorkerThread): void;
};

export function createAdmissionGate(): AdmissionGate {
    let acquire: AcquireWorkerThread | undefined;
    const extension = defineExtension({
        name: ADMISSION_EXTENSION_NAME,
        hooks: [
            hook(GenerationTask, {
                async beforeRequest(_request, api, context) {
                    if (!acquire) {
                        throw new Error("A model request was made before the admission was bound to its extension.");
                    }
                    await acquire(String(api.conversationId), context.abortSignal ?? new AbortController().signal);
                    return undefined;
                },
            }),
        ],
    });
    return {
        extension,
        bind(newAcquire) {
            if (acquire) throw new Error("The admission gate is already bound to an admission.");
            acquire = newAcquire;
        },
    };
}
