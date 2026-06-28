/**
 * Global ambient type declarations.
 *
 * SillyTavern provides jQuery as a host global. We declare minimal ambient
 * types here so `@ts-check` source files (e.g. src/ui/graph-viz.js) can
 * reference `$` and `JQuery` without requiring @types/jquery as a dependency.
 *
 * This is intentionally loose — UI files are not the type-strictness focus.
 */

/** JQuery instance returned by `$()` / `jQuery()`. */
interface JQuery {
    // Events — including delegated form: .on(event, selector, handler)
    on(event: string, selectorOrHandler: any, handler?: any): this;
    off(event: string, handler?: any): this;
    one(event: string, handler: any): this;
    trigger(event: string, ...args: any[]): this;
    // Traversal
    find(selector: string): JQuery;
    add(selector: string | Element | JQuery): JQuery;
    children(selector?: string): JQuery;
    parent(selector?: string): JQuery;
    parents(selector?: string): JQuery;
    closest(selector: string): JQuery;
    siblings(selector?: string): JQuery;
    next(selector?: string): JQuery;
    prev(selector?: string): JQuery;
    // Manipulation
    append(content: any): this;
    appendTo(target: any): this;
    prepend(content: any): this;
    after(content: any): this;
    before(content: any): this;
    remove(selector?: string): this;
    detach(selector?: string): this;
    empty(): this;
    html(content?: any): any;
    text(content?: any): any;
    val(value?: any): any;
    attr(name: string, value?: any): any;
    removeAttr(name: string): this;
    prop(name: string, value?: any): any;
    removeProp(name: string): this;
    data(name: string, value?: any): any;
    // CSS — both (prop, value) and object form ({ left, top, ... })
    css(property: string, value?: any): any;
    css(properties: Record<string, any>): this;
    addClass(className: string): this;
    removeClass(className?: string): this;
    toggleClass(className: string, state?: boolean): this;
    hasClass(className: string): boolean;
    // Effects
    show(duration?: any, callback?: any): this;
    hide(duration?: any, callback?: any): this;
    toggle(state?: any): this;
    fadeIn(duration?: any, callback?: any): this;
    fadeOut(duration?: any, callback?: any): this;
    fadeTo(duration: any, opacity: number, callback?: any): this;
    slideDown(duration?: any, callback?: any): this;
    slideUp(duration?: any, callback?: any): this;
    slideToggle(duration?: any, callback?: any): this;
    animate(properties: any, duration?: any, callback?: any): this;
    stop(clearQueue?: boolean, jumpToEnd?: boolean): this;
    // Dimensions / position
    width(value?: any): any;
    height(value?: any): any;
    innerWidth(): number;
    innerHeight(): number;
    outerHeight(includeMargin?: boolean): number;
    outerWidth(includeMargin?: boolean): number;
    scrollTop(value?: any): any;
    scrollLeft(value?: any): any;
    offset(coordinates?: { top: number; left: number }): any;
    position(): { top: number; left: number };
    // Iteration / inspection
    each(callback: (index: number, element: HTMLElement) => void): this;
    map(callback: (index: number, element: HTMLElement) => any): JQuery;
    get(index?: number): any;
    index(selector?: any): number;
    readonly length: number;
    [index: number]: HTMLElement;
    // Misc
    clone(withDataAndEvents?: boolean): JQuery;
    bind(event: string, handler: any): this;
    unbind(event?: string, handler?: any): this;
    [key: string]: any;
}

/** Static jQuery function. */
interface JQueryStatic {
    // Factory overloads — selector, Element, Document, or ready callback
    (selector: string, context?: any): JQuery;
    (element: Element): JQuery;
    (elementArray: Element[]): JQuery;
    (document: Document): JQuery;
    (object: any): JQuery;
    (callback: () => void): JQuery;
    // Static utilities
    ready(handler: () => void): void;
    ajax(settings: any): any;
    get(url: string, data?: any, success?: any, dataType?: any): any;
    post(url: string, data?: any, success?: any, dataType?: any): any;
    extend(deep: boolean, target: any, ...sources: any[]): any;
    extend(target: any, ...sources: any[]): any;
    each(collection: any, callback: (...args: any[]) => void): any;
    map(collection: any, callback: (...args: any[]) => any): any;
    grep(array: any[], callback: (...args: any[]) => boolean, invert?: boolean): any[];
    inArray(value: any, array: any[], fromIndex?: number): number;
    isArray(obj: any): boolean;
    isArrayLike(obj: any): boolean;
    isFunction(obj: any): boolean;
    isPlainObject(obj: any): boolean;
    isEmptyObject(obj: any): boolean;
    trim(str: string): string;
    noop(): void;
    now(): number;
    type(obj: any): string;
    holdReady(hold: boolean): void;
}

/** jQuery host global. */
declare const $: JQueryStatic;
/** jQuery host global (long form). */
declare const jQuery: JQueryStatic;
