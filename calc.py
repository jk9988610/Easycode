"""简单计算模块,提供 add / sub 两个函数。"""


def add(a, b):
    """返回 a 与 b 之和。"""
    return a + b


def sub(a, b):
    """返回 a 与 b 之差。"""
    return a - b


if __name__ == "__main__":
    print("add(2, 3) =", add(2, 3))
    print("sub(5, 2) =", sub(5, 2))
