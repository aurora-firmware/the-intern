// Read by `tsc` only (ADR-006 decision 3): web/tsconfig.json maps "preact" here. Pages still import from "preact".
// The relative path below is not caught by that mapping, so it reaches Preact's own declarations.
import type { Attributes, ComponentChildren, ComponentType, JSX, VNode } from "../../node_modules/preact/src/index.js";

export * from "../../node_modules/preact/src/index.js";

type DataAttributes = { [name: `data-${string}`]: string | number | boolean | undefined };

export function h<T extends keyof JSX.IntrinsicElements>(
    type: T,
    props: (JSX.IntrinsicElements[T] & DataAttributes) | null,
    ...children: ComponentChildren[]
): VNode;
export function h<P>(
    type: ComponentType<P>,
    props: (Attributes & NoInfer<P>) | (object extends NoInfer<P> ? null : never),
    ...children: ComponentChildren[]
): VNode;
