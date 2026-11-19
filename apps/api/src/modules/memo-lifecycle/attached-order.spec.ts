import { orderAttachedIds } from './attached-order';

describe('orderAttachedIds', () => {
  it('follows the tokens across saved and new files', () => {
    expect(orderAttachedIds('["new:1","old:10","new:0","old:11"]', [10, 11], [20, 21])).toEqual([
      21, 10, 20, 11,
    ]);
  });

  it('accepts an already-parsed array', () => {
    expect(orderAttachedIds(['old:11', 'old:10'], [10, 11], [])).toEqual([11, 10]);
  });

  it('without tokens keeps saved files first, then new ones in upload order', () => {
    expect(orderAttachedIds(undefined, [10, 11], [20, 21])).toEqual([10, 11, 20, 21]);
    expect(orderAttachedIds('not json', [10], [20])).toEqual([10, 20]);
  });

  it('ignores duplicates, removed/foreign ids and out-of-range indexes', () => {
    expect(
      orderAttachedIds(['new:0', 'new:0', 'old:99', 'new:5', 'old:x', 7, 'old:10'], [10], [20]),
    ).toEqual([20, 10]);
  });

  it('appends anything the tokens missed', () => {
    expect(orderAttachedIds(['new:1'], [10], [20, 21])).toEqual([21, 10, 20]);
  });
});
