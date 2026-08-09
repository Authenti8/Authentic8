"use client";

import { useState } from "react";
import { CheckoutButton } from "./checkout-button";

export function ExtraCreditPurchase() {
  const [quantityInput, setQuantityInput] = useState("10");
  const quantity = Number(quantityInput);
  const validQuantity = Number.isInteger(quantity) && quantity >= 1 && quantity <= 100;
  return (
    <section className="extra-credit-card">
      <div><span>Need more capacity?</span><h2>Buy extra interviews</h2><p>$5 per interview. Credits are added after Dodo confirms payment.</p></div>
      <label>Interviews<input aria-invalid={!validQuantity} max={100} min={1}
        onChange={(event) => setQuantityInput(event.target.value)} step={1} type="number"
        value={quantityInput} /></label>
      <div className="credit-total"><small>One-time total</small>
        <strong>{validQuantity ? `$${quantity * 5}` : "—"}</strong></div>
      {validQuantity
        ? <CheckoutButton label="Purchase credits" purpose="EXTRA_CREDITS" quantity={quantity} />
        : <div className="checkout-action"><button className="button-primary" disabled
            type="button">Purchase credits</button>
          <p role="alert">Enter a whole number from 1 to 100.</p></div>}
    </section>
  );
}
