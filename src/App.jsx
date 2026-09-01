import { useState } from 'react'
import './index.css'

function FenestraCalculator() {
  const [width, setWidth] = useState(100)
  const [height, setHeight] = useState(150)

  const area = (width * height) / 10000 // Convert to square meters

  return (
    <div className="calculator">
      <h1>Fenestra Calculator</h1>
      <div className="input-group">
        <label>
          Width (cm):
          <input
            type="number"
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
            min="0"
          />
        </label>
      </div>
      <div className="input-group">
        <label>
          Height (cm):
          <input
            type="number"
            value={height}
            onChange={(e) => setHeight(Number(e.target.value))}
            min="0"
          />
        </label>
      </div>
      <div className="result">
        <h2>Area: {area.toFixed(2)} m²</h2>
      </div>
    </div>
  )
}

export default FenestraCalculator
