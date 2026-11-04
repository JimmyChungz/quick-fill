declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string, options?: object);
    window: {
      document: Document;
      HTMLInputElement: typeof HTMLInputElement;
    };
  }
  export function fragment(html: string): DocumentFragment;
}
