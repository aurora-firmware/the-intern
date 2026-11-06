import { createContext, h } from "preact";
import { useContext } from "preact/hooks";

/**
 * Whether the page can reach the service, from the worker's word. Pages read it with `useContext(isConnected)` to
 * disable their actions while it is false; it is true until the worker says otherwise.
 */
export const isConnected = createContext(true);

/** The notice shown while the page can't reach the service. */
export const ConnectionBanner = () =>
    useContext(isConnected)
        ? null
        : h(
              "div",
              {
                  class: "connection-banner",
                  role: "alert",
                  style: "margin-bottom: 1rem; padding: 0.75rem 1rem; background: var(--color-orange-subtle); border-left: 4px solid var(--color-orange); color: var(--color-dark-blue);",
              },
              "The service can't be reached. Trying to connect again; what you type is kept.",
          );
