import { createContext, h } from "preact";
import { useContext } from "preact/hooks";
import type { NoDefaultModelNotice } from "../feed_hub.ts";

/**
 * What `daemon.status` reports while no default model is named (S-006 REQ-023), from the worker's status checks;
 * `null` while one is named. Pages read it with `useContext(noDefaultModel)`.
 */
export const noDefaultModel = createContext<NoDefaultModelNotice | null>(null);

/** The notice shown on every page while no default model is named. It disables no action. */
export const NoModelBanner = () =>
    useContext(noDefaultModel) === null
        ? null
        : h(
              "div",
              { class: "no-model-banner", role: "status" },
              "There is no default model. Work you send is accepted and waits until a team member signs in to pi " +
                  "and chooses one.",
          );
