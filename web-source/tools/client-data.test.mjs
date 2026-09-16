import test from 'node:test'
import assert from 'node:assert/strict'
import { isTransitPlace } from './client-data.mjs'
test('excludes transport and misclassified bike rental stations but keeps parking and universities', () => {
  assert.equal(isTransitPlace({ category: 'transport' }), true)
  assert.equal(isTransitPlace({ category: 'other', rawCategory: 'amenity=bicycle_rental' }), true)
  assert.equal(isTransitPlace({ category: 'parking', rawCategory: 'amenity=parking' }), false)
  assert.equal(isTransitPlace({ category: 'education', rawCategory: 'amenity=university' }), false)
})
