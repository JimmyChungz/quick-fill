import {beforeEach} from 'vitest';
// jsdom has no layout engine. Existing behavior tests use a neutral simulated
// rectangle; geometry-specific tests override it. Browser tests use real layout.
beforeEach(()=>{
 Object.defineProperty(Element.prototype,'getBoundingClientRect',{configurable:true,value:()=>new DOMRect(0,0,180,28)});
 Object.defineProperty(Element.prototype,'getClientRects',{configurable:true,value:function(this:Element){const rect=this.getBoundingClientRect();return rect.width&&rect.height?[rect]:[];}});
});
