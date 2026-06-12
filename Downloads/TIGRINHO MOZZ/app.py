from flask import Flask, render_template, send_from_directory

app = Flask(__name__)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/vsl')
def vsl():
    return render_template('vsl.html')

if __name__ == '__main__':
    app.run(debug=True, port=5000)
