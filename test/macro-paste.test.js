import test from "node:test";
import assert from "node:assert/strict";
import "../macro-paste.js";

const parse = globalThis.FuelMacroPaste.parse;

test("Spanish ChatGPT copy format with food name", () => {
  assert.deepEqual(parse("Salmón al horno: 500 kcal | 36 g proteína | 34 g carbohidratos | 24 g grasas"), {
    ok:true,name:"Salmón al horno",kcal:500,p:36,c:34,f:24
  });
});

test("English labels before numbers", () => {
  assert.deepEqual(parse("Salmon: Calories 500 | Protein 36 g | Carbs 34 g | Fat 24 g"), {
    ok:true,name:"Salmon",kcal:500,p:36,c:34,f:24
  });
});

test("Abbreviated format copied from ChatGPT", () => {
  const x=parse("Pumpkin spice: 101 kcal · P 0.7 g · C 15.6 g · G 3.6 g");
  assert.deepEqual([x.kcal,x.p,x.c,x.f],[101,0.7,15.6,3.6]);
});

test("Spanish decimal comma and thousands punctuation", () => {
  const x=parse("Para Fuel: 1.260 kcal | 66 g proteína | 111,5 g carbohidratos | 49 g grasas");
  assert.deepEqual([x.kcal,x.p,x.c,x.f],[1260,66,111.5,49]);
});

test("English thousands punctuation", () => {
  const x=parse("Dinner: 1,260 kcal | 66 g protein | 111 g carbohydrates | 49 g fat");
  assert.deepEqual([x.kcal,x.p,x.c,x.f],[1260,66,111,49]);
});

test("Multiline ChatGPT answer selects the Fuel totals rather than ingredient rows", () => {
  const x=parse("Salmón al horno\nSalmón: 290 kcal | 32 g proteína | 0 g carbohidratos | 18 g grasas\nPara registrar en Fuel: 500 kcal | 36 g proteína | 34 g carbohidratos | 24 g grasas");
  assert.deepEqual([x.kcal,x.p,x.c,x.f],[500,36,34,24]);
  assert.equal(x.name,"Salmón al horno");
});

test("Rejects incomplete macros instead of guessing or saving", () => {
  assert.equal(parse("Sopa: 400 kcal | 25 g proteínas | 30 g carbohidratos").ok,false);
  assert.equal(parse(" ").ok,false);
});

test("Rejects out-of-range figures", () => {
  assert.equal(parse("Meal: 15000 kcal | P 30 g | C 40 g | F 15 g").ok,false);
});
